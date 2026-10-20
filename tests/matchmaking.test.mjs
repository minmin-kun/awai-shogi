import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/api.js';
function memory(){const data=new Map();return {data,async create(code,room){if(data.has(code))throw Error('duplicate');data.set(code,{room:structuredClone(room),revision:0});},async get(code){return structuredClone(data.get(code)||null);},async save(code,room,revision){if(data.get(code)?.revision!==revision)return false;data.set(code,{room:structuredClone(room),revision:revision+1});return true;}};}
const ticket=()=>crypto.randomUUID()+crypto.randomUUID();
async function call(store,token,path='/api/matchmaking',method='POST'){
 const response=await api(new Request('http://local'+path,{method,headers:token?{Authorization:'Bearer '+token}:{},...(method==='POST'?{body:'{}'}:{})}),store);
 return {status:response.status,...await response.json()};
}
test('random matchmaking pairs two players with private credentials and playable rooms',async()=>{
 const store=memory(),a=ticket(),b=ticket();
 assert.equal((await call(store,a)).status,'waiting');
 const second=await call(store,b),first=await call(store,a);
 assert.equal(first.status,'matched');assert.equal(second.status,'matched');assert.equal(first.code,second.code);assert.equal(first.side,1-second.side);assert(first.joined);assert(first.random);assert.equal(first.deadline,null);
 assert.equal(first.keys,undefined);assert.equal(first.token,undefined);assert(!JSON.stringify(first).includes(b));
 const ready=await api(new Request(`http://local/api/rooms/${first.code}/ready`,{method:'POST',headers:{Authorization:'Bearer '+a},body:'{"round":1}'}),store);
 assert.equal(ready.status,200);assert((await ready.json()).deadline>Date.now());
 assert.equal((await call(store,ticket(),`/api/rooms/${first.code}`,'GET')).status,403);
});
test('concurrent entrants receive disjoint pairs and retries preserve assignments',async()=>{
 const store=memory(),tokens=Array.from({length:12},ticket);
 await Promise.all(tokens.map(t=>call(store,t)));
 const results=await Promise.all(tokens.map(t=>call(store,t)));
 assert(results.every(r=>r.status==='matched'));
 const rooms=new Map();for(const r of results){if(!rooms.has(r.code))rooms.set(r.code,[]);rooms.get(r.code).push(r.side);}
 assert.equal(rooms.size,6);for(const sides of rooms.values())assert.deepEqual(sides.sort(),[0,1]);
 for(let i=0;i<tokens.length;i++)assert.equal((await call(store,tokens[i])).code,results[i].code);
});
test('a repeated ticket cannot match itself; cancelled and stale waiters are excluded',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const store=memory(),a=ticket(),b=ticket(),c=ticket();
 await Promise.all([call(store,a),call(store,a)]);
 assert.equal((await call(store,a)).status,'waiting');
 assert.equal((await call(store,a,'/api/matchmaking/cancel')).status,'cancelled');
 assert.equal((await call(store,b)).status,'waiting');
 t.mock.timers.tick(21000);
 assert.equal((await call(store,c)).status,'waiting');
 assert.equal((await call(store,a)).status,'matched');
});
test('cancel racing pairing either removes the waiter or returns its already committed match',async()=>{
 const store=memory(),a=ticket(),b=ticket();await call(store,a);
 const [cancel,join]=await Promise.all([call(store,a,'/api/matchmaking/cancel'),call(store,b)]);
 if(cancel.status==='cancelled')assert.equal(join.status,'waiting');
 else{assert.equal(cancel.status,'matched');assert.equal(join.code,cancel.code);}
});
test('matched cancellation recovers the same room and cannot create a second assignment',async()=>{
 const store=memory(),a=ticket(),b=ticket();await call(store,a);const match=await call(store,b);
 const cancelled=await call(store,a,'/api/matchmaking/cancel');assert.equal(cancelled.status,'matched');assert.equal(cancelled.code,match.code);
 assert.equal((await call(store,a)).code,match.code);
});
test('queue endpoints require credentials and POST',async()=>{
 const store=memory();assert.equal((await call(store,null)).status,403);assert.equal((await call(store,'short')).status,403);assert.equal((await call(store,ticket(),'/api/matchmaking','GET')).status,405);
});
