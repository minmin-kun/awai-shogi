import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {ROOM_UPDATE_PROTOCOL,decodeRoomUpdate} from '../public/room-updates.js';
import {initial,resolve,MAX_ROUNDS} from '../src/engine.js';

async function runtime(t){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:fileURLToPath(new URL('../dist/server/index.js',import.meta.url)),compatibilityDate:'2026-10-20',d1Databases:['DB'],durableObjects:{ROOMS:{className:'RoomChannel',useSQLite:true},MATCHES:{className:'MatchChannel',useSQLite:true}}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 await db.exec(await readFile(new URL('../drizzle/0000_rooms.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../drizzle/0001_expiry_index.sql',import.meta.url),'utf8'));
 const request=async(path,body,token)=>{const response=await mf.dispatchFetch('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:token?{Authorization:'Bearer '+token}:{},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,...await response.json()};};
 async function socket(path,protocol){
  const response=await mf.dispatchFetch('http://localhost'+path,{headers:{Upgrade:'websocket',Origin:'http://localhost'}});assert.equal(response.status,101);
  const ws=response.webSocket;ws.accept();t.after(()=>{try{ws.close(1000);}catch{}});
  const messages=[],wireMessages=[],listeners=new Set();let id=0,baseline=null;
  ws.addEventListener('message',event=>{let data;try{data=JSON.parse(event.data);}catch{data=event.data;}wireMessages.push(data);if(data.update){baseline=decodeRoomUpdate(baseline,data.update);data={...data,data:structuredClone(baseline.state)};}messages.push(data);for(const listener of listeners)listener(data);});
  function wait(predicate){const existing=messages.find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{listeners.delete(listener);reject(Error('WebSocket event timeout'));},5000);function listener(data){if(predicate(data)){clearTimeout(timeout);listeners.delete(listener);resolve(data);}}listeners.add(listener);});}
  async function call(action,body,token){const key=String(++id);ws.send(JSON.stringify({id:key,action,body,token,...(action==='auth'&&protocol?{protocol}:{})}));const response=await wait(m=>m.id===key);if(response.error)throw Error(response.error);return response.data;}
  return {ws,messages,wireMessages,wait,call};
 }
 return {mf,db,request,socket};
}

test('real sockets authenticate, hide opponent plans, serialize concurrent moves and restore state',async t=>{
 const {db,request,socket}=await runtime(t);
 const a=await request('/api/rooms',{side:0}),b=await request(`/api/rooms/${a.code}/join`,{});
 const path=`/api/rooms/${a.code}`,sa=await socket(path+'/socket'),sb=await socket(path+'/socket');
 const first=await sa.call('auth',null,a.token);assert.equal(first.side,0);assert.equal(first.transport,'websocket');
 const second=await sb.call('auth',null,b.token);assert.deepEqual(second.presence,['online','online']);
 await Promise.all([sa.call('ready',{round:1}),sb.call('ready',{round:1})]);
 const version=(await db.prepare('SELECT revision FROM rooms WHERE code=?').bind(a.code).first()).revision;
 for(let i=0;i<3;i++){sa.ws.send('ping');await sa.wait(x=>x==='pong');await sa.call('sync');}
 assert.equal((await db.prepare('SELECT revision FROM rooms WHERE code=?').bind(a.code).first()).revision,version,'ping and sync must not write presence');
 await sa.call('plan',{round:1,plan:[{from:54,to:45}]});
 const hidden=await sb.wait(m=>m.type==='state'&&m.data.ready[0]);assert.equal(hidden.data.ownPlan,null);assert.equal(hidden.data.plans,undefined);assert.equal(hidden.data.keys,undefined);
 const next=await sb.call('plan',{round:1,plan:[{from:18,to:27}]});assert.equal(next.game.round,2);assert.equal(next.game.history.length,1);
 await sa.wait(m=>m.type==='state'&&m.data.game.round===2);
 sa.ws.close(1000);
 const disconnected=await sb.wait(m=>m.type==='state'&&m.data.presence[0]==='disconnected');assert.equal(disconnected.data.game.round,2);
 const restored=await socket(path+'/socket');const state=await restored.call('auth',null,a.token);assert.equal(state.game.round,2);assert.equal(state.game.board[45].s,0);
 const bad=await socket(path+'/socket');await assert.rejects(bad.call('auth',null,crypto.randomUUID()+crypto.randomUUID()),/参加情報/);
});

test('server alarm resolves timeouts without client polling',async t=>{
 const {db,request,socket}=await runtime(t);const a=await request('/api/rooms',{});await request(`/api/rooms/${a.code}/join`,{});
 const record=await db.prepare('SELECT data FROM rooms WHERE code=?').bind(a.code).first(),room=JSON.parse(record.data);
 room.deadlines=[Date.now()+500,Date.now()+500];room.readyBy=Date.now()+500;
 await db.prepare('UPDATE rooms SET data=? WHERE code=?').bind(JSON.stringify(room),a.code).run();
 const channel=await socket(`/api/rooms/${a.code}/socket`);await channel.call('auth',null,a.token);
 const state=await channel.wait(m=>m.type==='state'&&m.data.game.round===2);assert.equal(state.data.game.history.length,1);
 assert.deepEqual(state.data.game.history[0].events.map(e=>e.text),['パス','パス']);
});

test('matchmaking sockets push matches and retain connected waiters without renewal writes',async t=>{
 const {db,request,socket}=await runtime(t),a=crypto.randomUUID()+crypto.randomUUID(),b=crypto.randomUUID()+crypto.randomUUID();
 const waiting=await request('/api/matchmaking',{},a);assert.equal(waiting.status,'waiting');
 const channel=await socket('/api/matchmaking/socket');await channel.call('auth',null,a);
 const record=await db.prepare("SELECT data FROM rooms WHERE code='MATCH_QUEUE'").first(),queue=JSON.parse(record.data);queue.entries[0].expires=Date.now()-1000;
 await db.prepare("UPDATE rooms SET data=? WHERE code='MATCH_QUEUE'").bind(JSON.stringify(queue)).run();
 const match=await request('/api/matchmaking',{},b);assert.equal(match.status,'matched');
 const notified=await channel.wait(m=>m.type==='state'&&m.data.status==='matched');assert.equal(notified.data.code,match.code);assert.equal(notified.data.side,1-match.side);
});

test('websocket matchmaking cancellation removes the queue entry',async t=>{
 const {request,socket}=await runtime(t),a=crypto.randomUUID()+crypto.randomUUID(),b=crypto.randomUUID()+crypto.randomUUID();
 const channel=await socket('/api/matchmaking/socket');assert.equal((await channel.call('auth',null,a)).status,'waiting');
 assert.equal((await channel.call('cancel')).status,'cancelled');channel.ws.close(1000);
 assert.equal((await request('/api/matchmaking',{},b)).status,'waiting');
});

test('cross-origin upgrades and unauthenticated room commands are rejected',async t=>{
 const {mf,request,socket}=await runtime(t),room=await request('/api/rooms',{});
 const path=`/api/rooms/${room.code}/socket`;
 const forbidden=await mf.dispatchFetch('http://localhost'+path,{headers:{Upgrade:'websocket',Origin:'https://unrelated.example'}});assert.equal(forbidden.status,403);
 const channel=await socket(path);await assert.rejects(channel.call('plan',{round:1,plan:[]}),/認証/);
});

test('40 rounds use 160 room writes rather than time-based presence writes',async t=>{
 const {db,request,socket}=await runtime(t),a=await request('/api/rooms',{}),b=await request(`/api/rooms/${a.code}/join`,{});
 const path=`/api/rooms/${a.code}/socket`,sa=await socket(path),sb=await socket(path);
 await sa.call('auth',null,a.token);await sb.call('auth',null,b.token);
 const before=(await db.prepare('SELECT revision FROM rooms WHERE code=?').bind(a.code).first()).revision;
 for(let round=1;round<=40;round++){
  await Promise.all([sa.call('ready',{round}),sb.call('ready',{round})]);
  await Promise.all([sa.call('plan',{round,plan:[]}),sb.call('plan',{round,plan:[]})]);
 }
 const record=await db.prepare('SELECT data,revision FROM rooms WHERE code=?').bind(a.code).first();
 assert.equal(JSON.parse(record.data).game.round,41);assert.equal(record.revision-before,160);
 await sb.call('resign');
});

test('negotiated deltas coexist with legacy clients, hide plans, and resync after reconnect',async t=>{
 const {request,socket}=await runtime(t),a=await request('/api/rooms',{}),b=await request(`/api/rooms/${a.code}/join`,{});
 const path=`/api/rooms/${a.code}/socket`,sa=await socket(path,ROOM_UPDATE_PROTOCOL),sb=await socket(path);
 await sa.call('auth',null,a.token);await sb.call('auth',null,b.token);assert.equal(sa.wireMessages[0].update.type,'snapshot');assert(sb.wireMessages.every(m=>!m.update));
 await Promise.all([sa.call('ready',{round:1}),sb.call('ready',{round:1})]);
 await sb.call('plan',{round:1,plan:[{from:18,to:27}]});
 const hidden=(await sa.wait(m=>m.type==='state'&&m.data.ready[1])).data;assert.equal(hidden.ownPlan,null);assert.equal(hidden.keys,undefined);assert(!JSON.stringify(sa.wireMessages).includes(b.token));
 const next=await sa.call('plan',{round:1,plan:[{from:54,to:45}]});assert.equal(next.game.round,2);assert.equal(next.game.history.length,1);
 const delta=sa.wireMessages.find(m=>m.update?.history?.append.length===1);assert.equal(delta.update.type,'delta');assert.equal(delta.update.history.from,0);
 const full=await sa.call('sync');assert.equal(sa.wireMessages.at(-1).update.type,'snapshot');assert.deepEqual(full.game,next.game);
 sa.ws.close(1000);const restored=await socket(path,ROOM_UPDATE_PROTOCOL);const recovered=await restored.call('auth',null,a.token);assert.equal(restored.wireMessages[0].update.type,'snapshot');assert.deepEqual(recovered.game,next.game);
 await restored.call('resign');
});

test('HTTP abuse limits reject creation bursts, oversized forwarded bodies and foreign origins',async t=>{
 const {mf,request}=await runtime(t);
 const large=await mf.dispatchFetch('http://localhost/api/rooms/DEADBEEF/join',{method:'POST',body:JSON.stringify({padding:'あ'.repeat(3000)})});assert.equal(large.status,413);
 const foreign=await mf.dispatchFetch('http://localhost/api/rooms',{method:'POST',headers:{Origin:'https://unrelated.example'},body:'{}'});assert.equal(foreign.status,403);
 for(let i=0;i<10;i++)assert.equal((await request('/api/rooms',{})).status,201);
 const limited=await mf.dispatchFetch('http://localhost/api/rooms',{method:'POST',body:'{}'});assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');
 assert.equal(limited.headers.get('X-Frame-Options'),'DENY');
});

test('pending sockets are capped and closed after the authentication deadline',async t=>{
 const {mf,socket}=await runtime(t),path='/api/rooms/DEADBEEF/socket';
 const channels=[];for(let i=0;i<6;i++)channels.push(await socket(path));
 const rejected=await mf.dispatchFetch('http://localhost'+path,{headers:{Upgrade:'websocket',Origin:'http://localhost'}});assert.equal(rejected.status,429);
 const closed=await new Promise(resolve=>channels[0].ws.addEventListener('close',resolve,{once:true}));assert.equal(closed.code,1008);
});

test('oversized UTF-8 frames and repeated resync requests close abusive connections',async t=>{
 const {request,socket}=await runtime(t),room=await request('/api/rooms',{}),path=`/api/rooms/${room.code}/socket`;
 const huge=await socket(path);await huge.call('auth',null,room.token);
 const hugeClosed=new Promise(resolve=>huge.ws.addEventListener('close',resolve,{once:true}));
 huge.ws.send(JSON.stringify({id:'large',action:'sync',padding:'あ'.repeat(3000)}));assert.equal((await hugeClosed).code,1009);
 const spam=await socket(path);await spam.call('auth',null,room.token);
 for(let i=0;i<10;i++)await spam.call('sync');
 const spamClosed=new Promise(resolve=>spam.ws.addEventListener('close',resolve,{once:true}));
 spam.ws.send(JSON.stringify({id:'spam',action:'sync'}));assert.equal((await spamClosed).code,1008);
});

test('the final allowed round delivers a draw through real delta sockets and stops play',async t=>{
 const {db,request,socket}=await runtime(t),a=await request('/api/rooms',{}),b=await request(`/api/rooms/${a.code}/join`,{});
 const row=await db.prepare('SELECT data FROM rooms WHERE code=?').bind(a.code).first(),room=JSON.parse(row.data);
 let game=initial();for(let i=1;i<MAX_ROUNDS;i++)game=resolve(game,[[],[]]);room.game=game;
 await db.prepare('UPDATE rooms SET data=? WHERE code=?').bind(JSON.stringify(room),a.code).run();
 const path=`/api/rooms/${a.code}/socket`,sa=await socket(path,ROOM_UPDATE_PROTOCOL),sb=await socket(path,ROOM_UPDATE_PROTOCOL);
 await sa.call('auth',null,a.token);await sb.call('auth',null,b.token);
 await Promise.all([sa.call('ready',{round:MAX_ROUNDS}),sb.call('ready',{round:MAX_ROUNDS})]);
 await sa.call('plan',{round:MAX_ROUNDS,plan:[]});const drawn=await sb.call('plan',{round:MAX_ROUNDS,plan:[]});
 assert.equal(drawn.game.winner,-1);assert.equal(drawn.game.endReason,'turn_limit');assert.equal(drawn.game.history.length,MAX_ROUNDS);
 const pushed=await sa.wait(m=>m.type==='state'&&m.data.game.winner===-1);assert.deepEqual(pushed.data.game,drawn.game);
 await assert.rejects(sa.call('ready',{round:MAX_ROUNDS+1}),/開始/);
 assert.equal((await sa.call('sync')).game.history.length,MAX_ROUNDS);
});
