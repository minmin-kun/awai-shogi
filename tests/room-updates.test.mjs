import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,resolve} from '../src/engine.js';
import {encodeRoomUpdate,decodeRoomUpdate} from '../public/room-updates.js';
const snapshot=(game=initial(),version=0)=>({code:'ABCD1234',side:0,version,game,joined:true,ready:[false,false],ownPlan:null,deadline:null,presence:['online','online'],serverTime:1800000000000,transport:'websocket',random:false});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
async function start(state=snapshot()){const encoded=await encodeRoomUpdate(null,state);return {server:encoded.cursor,client:decodeRoomUpdate(null,encoded.update),state};}

test('metadata-only deltas do not resend the board or history and preserve nulls',async()=>{
 const {server,client,state}=await start(),next={...state,version:1,deadline:123,ready:[true,false],ownPlan:[{from:54,to:45}]};
 const {cursor,update}=await encodeRoomUpdate(server,next);
 assert.equal(update.type,'delta');assert.equal(update.board,undefined);assert.equal(update.history,undefined);assert.deepEqual(update.game,{set:{},remove:[]});
 assert.deepEqual(decodeRoomUpdate(client,update).state,next);
 const cleared={...next,version:2,deadline:null,ownPlan:null};const encoded=await encodeRoomUpdate(cursor,cleared);
 assert.deepEqual(decodeRoomUpdate(decodeRoomUpdate(client,update),encoded.update).state,cleared);
});

test('moves send only changed squares and append exactly one history entry',async()=>{
 const {server,client,state}=await start();
 const next=snapshot(resolve(state.game,[[{from:54,to:45}],[{from:18,to:27}]]),1);
 const {update}=await encodeRoomUpdate(server,next);
 assert.deepEqual(update.board.map(([i])=>i),[18,27,45,54]);assert.equal(update.history.from,0);assert.equal(update.history.append.length,1);
 assert.deepEqual(decodeRoomUpdate(client,update).state,next);
 assert.equal(client.state.game.board[54].s,0);assert.equal(client.state.game.history.length,0,'baseline is immutable');
});

test('captures, hands, promotion, double-move state, resignation, and deleted properties round trip',async()=>{
 const {server,client,state}=await start();const next=structuredClone(state);
 next.version=1;next.game.board[54]=null;next.game.board[0]={id:1,t:'+P',s:0};next.game.hands[0]={P:1,R:1};next.game.doubleUsed=true;next.game.leader=1;next.game.winner=0;next.game.resigned=1;delete next.random;
 const {update}=await encodeRoomUpdate(server,next);const result=decodeRoomUpdate(client,update);
 assert.deepEqual(result.state,next);assert.deepEqual(update.changes.remove,['random']);
 const independent=structuredClone(result.state);independent.game.board[0].t='K';independent.game.history.push({});assert.equal(result.state.game.board[0].t,'+P');assert.equal(result.state.game.history.length,0);
});

test('missed updates and broken history offsets fail without partially modifying the baseline',async()=>{
 const {server,client,state}=await start(),a={...state,version:1,deadline:200};const first=await encodeRoomUpdate(server,a),second=await encodeRoomUpdate(first.cursor,{...a,version:2,deadline:300});
 assert.throws(()=>decodeRoomUpdate(client,second.update),/baseline/);assert.equal(client.state.deadline,null);
 const next=await encodeRoomUpdate(server,snapshot(resolve(state.game,[[],[]]),1));
 const broken=structuredClone(next.update);broken.history.from=1;assert.throws(()=>decodeRoomUpdate(client,broken),/History/);assert.equal(client.state.game.history.length,0);
 const badBoard=structuredClone(next.update);badBoard.board=[[81,null]];assert.throws(()=>decodeRoomUpdate(client,badBoard),/board/);
 const full=await encodeRoomUpdate(second.cursor,snapshot(resolve(state.game,[[],[]]),3),true);
 assert.equal(full.update.type,'snapshot');assert.deepEqual(decodeRoomUpdate(client,full.update).state,full.update.state);
});

test('duplicates and stale updates are ignored; room and side mismatches are rejected',async()=>{
 const {server,client,state}=await start(),encoded=await encodeRoomUpdate(server,{...state,version:1,deadline:123});const next=decodeRoomUpdate(client,encoded.update);
 assert.equal(decodeRoomUpdate(next,encoded.update).ignored,true);assert.deepEqual(decodeRoomUpdate(next,encoded.update).state,next.state);
 for(const changes of [{code:'EEEE1111'},{side:1},{protocol:'unknown'}])assert.throws(()=>decodeRoomUpdate(client,{...encoded.update,...changes}));
 const evil=structuredClone(encoded.update);evil.game.set=JSON.parse('{"__proto__":{"polluted":true}}');assert.throws(()=>decodeRoomUpdate(client,evil));assert.equal({}.polluted,undefined);
});

test('rewritten history is sent as a full snapshot; hibernation cursors never contain history',async()=>{
 const state=snapshot(resolve(initial(),[[],[]]),1),{server,client}=await start(state);assert.equal(server.state.game.history,undefined);
 const rewritten=structuredClone(state);rewritten.version=2;rewritten.game.history[0].events[0].text='更新された棋譜';
 const encoded=await encodeRoomUpdate(server,rewritten);assert.equal(encoded.update.type,'snapshot');assert.deepEqual(decodeRoomUpdate(client,encoded.update).state,rewritten);
 const afterWake=JSON.parse(JSON.stringify(encoded.cursor));const metadata={...rewritten,version:3,deadline:100};const delta=await encodeRoomUpdate(afterWake,metadata);assert.equal(delta.update.type,'delta');
 assert.deepEqual(decodeRoomUpdate(decodeRoomUpdate(client,encoded.update),delta.update).state,metadata);
});

test('300-round history remains exact while each new update stays small',async()=>{
 let {server,client,state}=await start();let fullBytes=0,deltaBytes=0;
 for(let round=1;round<=300;round++){
  state=snapshot(resolve(state.game,[[],[]]),round);state.serverTime+=round;
  const encoded=await encodeRoomUpdate(server,state);server=encoded.cursor;client=decodeRoomUpdate(client,encoded.update);
  assert.deepEqual(client.state,state);assert.equal(encoded.update.history.append.length,1);
  assert(bytes(encoded.update)<1500);assert(bytes(server)<8000);
  fullBytes+=bytes(state);deltaBytes+=bytes(encoded.update);
 }
 assert(deltaBytes<fullBytes/10);console.log(`300 rounds: full=${fullBytes} bytes, delta=${deltaBytes} bytes, reduction=${(100*(1-deltaBytes/fullBytes)).toFixed(1)}%`);
 const metadata=await encodeRoomUpdate(server,{...state,presence:['online','disconnected']});assert.equal(metadata.update.history,undefined);assert(bytes(metadata.update)<500);
});
