import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {initial,resolve,MAX_ROUNDS} from '../src/engine.js';
import {api,settle} from '../src/api.js';
import {cleanupExpired} from '../src/maintenance.js';

test('expiry cleanup is indexed, bounded and preserves valid rooms and queue state',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(await readFile(new URL('../drizzle/0000_rooms.sql',import.meta.url),'utf8'));db.exec(await readFile(new URL('../drizzle/0001_expiry_index.sql',import.meta.url),'utf8'));
  const insert=db.prepare('INSERT INTO rooms VALUES (?, ?, 0, ?)');
  for(let i=0;i<510;i++)insert.run('expired'+i,'{}',999);
  insert.run('live-room','{}',2000);insert.run('MATCH_QUEUE','{}',Number.MAX_SAFE_INTEGER);insert.run('MATCH_valid','{}',2000);
  const adapter={prepare(sql){return {bind(...args){return {run(){return db.prepare(sql).run(...args);}};}};}};
  assert.equal((await cleanupExpired(adapter,1000)).changes,500);
  assert.equal((await cleanupExpired(adapter,1000)).changes,10);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rooms').get().n,3);
  assert(db.prepare('EXPLAIN QUERY PLAN SELECT code FROM rooms WHERE expires <= ? ORDER BY expires LIMIT 500').all(1000).some(row=>row.detail.includes('rooms_expires_idx')));
 }finally{db.close();}
});

test('the turn limit draws a long game, preserves a king capture and stops history growth',()=>{
 let game=initial();game.round=MAX_ROUNDS;const result=resolve(game,[[],[]]);assert.equal(result.winner,-1);assert.equal(result.endReason,'turn_limit');assert.equal(result.history.length,1);
 assert.deepEqual(resolve(result,[[],[]]),result);
 game.board.fill(null);game.board[40]={id:1,t:'R',s:0};game.board[31]={id:2,t:'K',s:1};
 const win=resolve(game,[[{from:40,to:31,id:1}],[]]);assert.equal(win.winner,0);assert.equal(win.endReason,undefined);
 const legacy={game:{...initial(),round:MAX_ROUNDS+10},joined:true,plans:[null,null],deadline:null};assert(settle(legacy,Date.now()));assert.equal(legacy.game.winner,-1);assert.deepEqual(legacy.deadlines,[null,null]);
});

test('an online game at the limit cannot append history through further plan requests',async()=>{
 const game=initial();game.round=MAX_ROUNDS;
 const room={code:'AB12CD34',game,joined:true,keys:['a','b'],plans:[null,null],deadlines:[Date.now()+30000,Date.now()+30000],lastSeen:[null,null]};let revision=0;
 const store={authKey:'a',trackPresence:false,async get(){return {room:structuredClone(room),revision};},async save(_code,next,expected){assert.equal(expected,revision);Object.assign(room,structuredClone(next));revision++;return true;}};
 async function plan(key,round){store.authKey=key;return api(new Request('http://local/api/rooms/AB12CD34/plan',{method:'POST',body:JSON.stringify({round,plan:[]})}),store);}
 assert.equal((await plan('a',MAX_ROUNDS)).status,200);assert.equal((await plan('b',MAX_ROUNDS)).status,200);assert.equal(room.game.winner,-1);
 assert.equal((await plan('a',MAX_ROUNDS+1)).status,409);assert.equal(room.game.history.length,1);
});
