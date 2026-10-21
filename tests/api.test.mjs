import test from 'node:test';import assert from 'node:assert/strict';import {api} from '../src/api.js';
function memory(){const data=new Map();return {data,async create(c,r){data.set(c,{room:structuredClone(r),revision:0});},async get(c){return structuredClone(data.get(c)||null);},async save(c,r,v){if(data.get(c).revision!==v)return false;data.set(c,{room:structuredClone(r),revision:v+1});return true;}};}
async function call(store,path,body,token){const res=await api(new Request('http://local'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{'Authorization':'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),store);return {status:res.status,data:await res.json()};}
async function players(){let store=memory();let a=(await call(store,'/api/rooms',{side:0})).data;let b=(await call(store,`/api/rooms/${a.code}/join`,{})).data;a={...(await call(store,`/api/rooms/${a.code}/ready`,{round:1},a.token)).data,token:a.token};b={...(await call(store,`/api/rooms/${a.code}/ready`,{round:1},b.token)).data,token:b.token};return {store,a,b,path:`/api/rooms/${a.code}`};}
test('create/join, room full, and authentication',async()=>{const {store,a,b,path}=await players();assert.equal(a.side,0);assert.equal(b.side,1);assert(b.deadline>Date.now());assert.equal((await call(store,path)).status,403);assert.equal((await call(store,path+'/join',{})).status,409);assert.equal((await call(store,path,undefined,a.token)).status,200);});
test('opponent plans and tokens stay private',async()=>{const {store,a,b,path}=await players();await call(store,path+'/plan',{round:1,plan:[{from:54,to:45}]},a.token);const r=(await call(store,path,undefined,b.token)).data;assert.deepEqual(r.ready,[true,false]);assert.equal(r.ownPlan,null);assert.equal(r.keys,undefined);assert.equal(r.plans,undefined);assert(!JSON.stringify(r).includes(a.token));});
test('concurrent confirmations resolve exactly once',async()=>{const {store,a,b,path}=await players();const out=await Promise.all([call(store,path+'/plan',{round:1,plan:[{from:54,to:45}]},a.token),call(store,path+'/plan',{round:1,plan:[{from:18,to:27}]},b.token)]);assert(out.every(x=>x.status===200));let r=(await call(store,path,undefined,a.token)).data;assert.equal(r.game.round,2);assert.equal(r.game.history.length,1);assert(r.game.board[45]);assert(r.game.board[27]);assert.equal((await call(store,path+'/plan',{round:1,plan:[]},a.token)).status,409);});
test('time out passes unconfirmed plans, even if client disappears',async()=>{const {store,a,b,path}=await players();await call(store,path+'/plan',{round:1,plan:[{from:54,to:45}]},a.token);store.data.get(a.code).room.deadlines[1]=Date.now()-1;const r=(await call(store,path,undefined,b.token)).data;assert.equal(r.game.round,2);assert.equal(r.game.history[0].events[1].text,'パス');assert(r.game.board[45]);});
test('invalid plans rejected, resignation finishes match',async()=>{const {store,a,b,path}=await players();assert.equal((await call(store,path+'/plan',{round:1,plan:[{from:54,to:44}]},a.token)).status,400);const r=(await call(store,path+'/resign',{},b.token)).data;assert.equal(r.game.winner,0);assert.equal((await call(store,path+'/plan',{round:1,plan:[]},a.token)).status,409);});
test('online API accepts a blocked reservation and resolves using the actual execution board',async()=>{const {store,a,b,path}=await players();const s=store.data.get(a.code).room.game;s.board.fill(null);s.board[4]={id:100,t:'R',s:1};s.board[22]={id:101,t:'R',s:0};
 const reserved=await call(store,path+'/plan',{round:1,plan:[{from:4,to:40}]},b.token);assert.equal(reserved.status,200);
 const hidden=(await call(store,path,undefined,a.token)).data;assert.equal(hidden.ownPlan,null);assert.equal(hidden.plans,undefined);
 const executed=(await call(store,path+'/plan',{round:1,plan:[{from:22,to:21}]},a.token)).data;
 assert.equal(executed.game.board[40].id,100);assert(executed.game.last[1].ok);
});
test('online API rejects moving a first-move drop without consuming the double move',async()=>{
 const {store,a,b,path}=await players();const room=store.data.get(a.code).room;
 room.game.hands[1].R=1;
 const rejected=await call(store,path+'/plan',{round:1,plan:[{drop:'R',to:40},{from:40,to:49,id:999}]},b.token);
 assert.equal(rejected.status,400);assert.match(rejected.data.error,/二手打ち/);assert.equal(room.game.doubleUsed,false);assert.equal(room.plans[1],null);
 const accepted=await call(store,path+'/plan',{round:1,plan:[{drop:'R',to:40},{from:18,to:27}]},b.token);assert.equal(accepted.status,200);
});
test('next-round clocks remain stopped until animation acknowledgement, then grant 30 seconds',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const {store,a,b,path}=await players();
 await call(store,path+'/plan',{round:1,plan:[]},a.token);let next=(await call(store,path+'/plan',{round:1,plan:[]},b.token)).data;
 assert.equal(next.game.round,2);assert.equal(next.deadline,null);
 t.mock.timers.tick(4200);next=(await call(store,path+'/ready',{round:2},b.token)).data;assert.equal(next.deadline-Date.now(),30000);
 const first=(await call(store,path,undefined,a.token)).data;assert.equal(first.deadline,null);
 t.mock.timers.tick(1300);const own=(await call(store,path+'/ready',{round:2},a.token)).data;assert.equal(own.deadline-Date.now(),30000);
 assert.equal((await call(store,path,undefined,b.token)).data.deadline,next.deadline);
});
test('repeated ready requests and reloads never reset a running clock',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const {store,a,path}=await players();const before=(await call(store,path,undefined,a.token)).data.deadline;
 t.mock.timers.tick(5000);const again=(await call(store,path+'/ready',{round:1},a.token)).data;assert.equal(again.deadline,before);
 assert.equal((await call(store,path+'/ready',{round:99},a.token)).status,409);
});
test('timing out one player does not resolve while the other still has time',async()=>{
 const {store,a,b,path}=await players();const r=store.data.get(a.code).room;r.deadlines[0]=Date.now()-1;r.deadlines[1]=Date.now()+25000;
 const partial=(await call(store,path,undefined,b.token)).data;assert.equal(partial.game.round,1);assert.deepEqual(partial.ready,[true,false]);
 const finished=(await call(store,path+'/plan',{round:1,plan:[]},b.token)).data;assert.equal(finished.game.round,2);
});
test('disconnected animation acknowledgement has a bounded fallback',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const store=memory();const a=(await call(store,'/api/rooms',{side:0})).data;
 await call(store,`/api/rooms/${a.code}/join`,{});const path=`/api/rooms/${a.code}`;
 assert.equal((await call(store,path+'/plan',{round:1,plan:[]},a.token)).status,409);
 t.mock.timers.tick(10000);const started=(await call(store,path,undefined,a.token)).data;assert.equal(started.deadline-Date.now(),30000);
 t.mock.timers.tick(30000);assert.equal((await call(store,path,undefined,a.token)).data.game.round,2);
});
test('presence distinguishes active thinking, lost heartbeat, and reconnection',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const {store,a,b,path}=await players();
 let state=(await call(store,path,undefined,a.token)).data;assert.deepEqual(state.presence,['online','online']);assert.deepEqual(state.ready,[false,false]);const deadline=state.deadline;
 t.mock.timers.tick(13000);state=(await call(store,path,undefined,a.token)).data;assert.deepEqual(state.presence,['online','disconnected']);assert.equal(state.game.round,1);assert.equal(state.deadline,deadline);
 await call(store,path,undefined,b.token);state=(await call(store,path,undefined,a.token)).data;assert.deepEqual(state.presence,['online','online']);assert.equal(state.deadline,deadline);
});
test('unauthorized traffic cannot refresh a disconnected player or reveal presence',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const {store,a,b,path}=await players();const before=store.data.get(a.code).room.lastSeen[b.side];t.mock.timers.tick(13000);
 assert.equal((await call(store,path,undefined,'invalid-token')).status,403);assert.equal(store.data.get(a.code).room.lastSeen[b.side],before);
 const state=(await call(store,path,undefined,a.token)).data;assert.equal(state.presence[b.side],'disconnected');assert.equal(state.keys,undefined);assert.equal(state.plans,undefined);assert.equal(state.lastSeen,undefined);
});
test('presence writes are throttled and waiting rooms do not invent an opponent',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const store=memory();const a=(await call(store,'/api/rooms',{side:0})).data;const path=`/api/rooms/${a.code}`;assert.deepEqual(a.presence,['online','waiting']);
 const rev=store.data.get(a.code).revision;t.mock.timers.tick(1000);await call(store,path,undefined,a.token);assert.equal(store.data.get(a.code).revision,rev);
 t.mock.timers.tick(2000);await call(store,path,undefined,a.token);assert.equal(store.data.get(a.code).revision,rev+1);
});
