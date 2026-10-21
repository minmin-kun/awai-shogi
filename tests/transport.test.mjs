import test from 'node:test';
import assert from 'node:assert/strict';
import {initial} from '../src/engine.js';
import {RealtimeChannel} from '../public/transport.js';
import {ROOM_UPDATE_PROTOCOL,encodeRoomUpdate} from '../public/room-updates.js';
import {quotaPayload,QUOTA_CODE} from '../public/service-errors.js';

test('the browser transport resyncs a missing delta without replaying a submitted move',async t=>{
 const originalSocket=Object.getOwnPropertyDescriptor(globalThis,'WebSocket'),originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
 let cursor=null,state={code:'ABCD1234',side:0,version:0,game:initial(),joined:true,ready:[false,false],ownPlan:null,deadline:null,presence:['online','online'],serverTime:1,transport:'websocket'},socket;
 const actions=[],states=[],listeners=new Set();
 class FakeSocket{
  constructor(){socket=this;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
  async send(raw){
   if(raw==='ping'){this.emit('pong');return;}
   const message=JSON.parse(raw);actions.push(message.action);
   if(message.action==='auth')assert.equal(message.protocol,ROOM_UPDATE_PROTOCOL);
   if(message.action==='ready'){state={...state,version:state.version+1,deadline:123};}
   if(message.action==='plan'){state={...state,version:state.version+1,ready:[true,false],ownPlan:message.body.plan};}
   const encoded=await encodeRoomUpdate(cursor,state,['auth','sync'].includes(message.action));cursor=encoded.cursor;
   this.emit({id:message.id,update:encoded.update});
  }
  emit(message){this.onmessage?.({data:typeof message==='string'?message:JSON.stringify(message)});}
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
 }
 Object.defineProperty(globalThis,'WebSocket',{value:FakeSocket,configurable:true});Object.defineProperty(globalThis,'location',{value:{href:'https://test.local/'},configurable:true});
 t.after(()=>{if(originalSocket)Object.defineProperty(globalThis,'WebSocket',originalSocket);else delete globalThis.WebSocket;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;});
 function nextState(predicate){const found=states.find(predicate);if(found)return Promise.resolve(found);return new Promise(resolve=>{const listener=value=>{if(predicate(value)){listeners.delete(listener);resolve(value);}};listeners.add(listener);});}
 const channel=new RealtimeChannel('/api/rooms/ABCD1234/socket','a'.repeat(64),{onState:value=>{states.push(value);for(const listener of listeners)listener(value);}});t.after(()=>channel.close());
 await nextState(s=>s.version===0);
 assert.equal((await channel.call('ready')).deadline,123);
 // Simulate a renderer mutating the game it was handed during an animation.
 states[0].game.board[0]=null;assert(channel.roomUpdateState.state.game.board[0]);
 // Server advances once, but this frame is deliberately dropped.
 state={...state,version:2,presence:['online','disconnected']};cursor=(await encodeRoomUpdate(cursor,state)).cursor;
 await assert.rejects(channel.call('plan',{round:1,plan:[{from:54,to:45}]}),/再同期/);
 const recovered=await nextState(s=>s.version===3);assert(recovered.ready[0]);assert.deepEqual(recovered.ownPlan,[{from:54,to:45}]);assert.equal(recovered.game.board[0].t,'L');
 assert.equal(actions.filter(action=>action==='plan').length,1);assert.equal(actions.filter(action=>action==='sync').length,1);
 assert.equal(channel.roomUpdateState.seq,cursor.seq);channel.close();
});

test('a quota reply rejects pending moves, stops reconnection and notifies the UI once',async t=>{
 const originals=new Map(['WebSocket','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let socket,created=0,quotaCount=0;
 class FakeSocket{
  constructor(){socket=this;created++;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
  send(raw){const message=JSON.parse(raw);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(message.action==='auth'?{id:message.id,data:{version:0}}:{id:message.id,...quotaPayload()})}));}
  close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
 }
 Object.defineProperty(globalThis,'WebSocket',{value:FakeSocket,configurable:true});Object.defineProperty(globalThis,'location',{value:{href:'https://test.local/'},configurable:true});
 t.after(()=>{for(const [key,value] of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 let ready;const initialized=new Promise(resolve=>{ready=resolve;});
 const channel=new RealtimeChannel('/api/rooms/ABCD1234/socket','a'.repeat(64),{onState:ready,onQuota:()=>quotaCount++});t.after(()=>channel.close());await initialized;
 await assert.rejects(channel.call('plan',{round:1,plan:[]}),{code:QUOTA_CODE});
 assert.equal(channel.closed,true);assert.equal(channel.authenticated,false);assert.equal(channel.pending.size,0);assert.equal(socket.readyState,3);assert.equal(quotaCount,1);
 await channel.resume();await assert.rejects(channel.call('sync'),{code:QUOTA_CODE});assert.equal(created,1);
});

test('a failed handshake checks HTTP for Cloudflare 1027 without repeating game commands',async t=>{
 const originals=new Map(['WebSocket','location','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let probes=0,quotaReady;
 const detected=new Promise(resolve=>{quotaReady=resolve;});
 class FailedSocket{constructor(){this.readyState=0;queueMicrotask(()=>this.close());}close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}}
 Object.defineProperty(globalThis,'WebSocket',{value:FailedSocket,configurable:true});Object.defineProperty(globalThis,'location',{value:{href:'https://test.local/'},configurable:true});
 Object.defineProperty(globalThis,'fetch',{value:async path=>{assert.equal(path,'/api/status');probes++;return new Response('<h1>Error 1027</h1>',{status:429});},configurable:true});
 t.after(()=>{for(const [key,value] of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 const channel=new RealtimeChannel('/api/rooms/ABCD1234/socket','a'.repeat(64),{onQuota:quotaReady});t.after(()=>channel.close());
 assert.equal((await detected).code,QUOTA_CODE);assert.equal(probes,1);assert.equal(channel.closed,true);
});
