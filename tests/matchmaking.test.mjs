import test from 'node:test';
import assert from 'node:assert/strict';
import {api,hash,MATCH_QUEUE_LIMIT} from '../src/api.js';
import {initial} from '../src/engine.js';
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

test('matchmaking consumes forwarded POST bodies before returning a response',async()=>{
 const request=new Request('http://local/api/matchmaking',{method:'POST',headers:{Authorization:'Bearer '+ticket()},body:'{}'});
 assert.equal((await api(request,memory())).status,200);assert(request.bodyUsed);
});

test('reserved codes retry collisions without returning or changing an existing room',async t=>{
 const store=memory(),a=ticket(),b=ticket(),occupied='AB12CD34';
 const victim={code:occupied,game:initial(),joined:true,keys:['victim0','victim1'],plans:[[{from:54,to:45}],null],deadline:null,random:true};await store.create(occupied,victim);
 await call(store,a);let attempts=0;t.mock.method(crypto,'randomUUID',()=> (++attempts===1?occupied:'BC23DE45')+'-0000-4000-8000-000000000000');
 const match=await call(store,b);assert.equal(match.status,'matched');assert.equal(match.code,'BC23DE45');assert.equal(attempts,2);
 assert.deepEqual(store.data.get(occupied).room,victim);assert.equal(match.ownPlan,null);
 assert.equal((await call(store,a)).code,match.code);
});

test('legacy collision assignments cannot expose the unrelated room or private plan',async()=>{
 const store=memory(),a=ticket(),b=ticket(),keys=[await hash(a),await hash(b)],code='AB12CD34';
 await store.create(code,{code,game:initial(),joined:true,keys:['victim0','victim1'],plans:[[{from:54,to:45}],null],deadline:null,random:true});
 await store.create('MATCH_QUEUE',{entries:keys.map((key,side)=>({key,expires:Date.now()+86400000,match:{code,keys,side}}))});
 for(const token of [a,b]){const result=await call(store,token);assert.equal(result.status,403);assert.equal(result.game,undefined);assert.equal(result.ownPlan,undefined);}
});

test('many completed pairs leave a small queue and independently recoverable assignments',async()=>{
 const store=memory();let firstToken,firstCode;
 for(let i=0;i<150;i++){
  const a=ticket(),b=ticket();await call(store,a);const match=await call(store,b);assert.equal(match.status,'matched');
  if(i===0){firstToken=a;firstCode=match.code;}
  assert.equal(store.data.get('MATCH_QUEUE').room.entries.length,0);
 }
 assert.equal((await call(store,firstToken)).code,firstCode);
 assert.equal([...store.data.keys()].filter(code=>code.startsWith('MATCH_')&&code!=='MATCH_QUEUE').length,300);
});

test('a full handoff queue rejects new work and archive failures preserve pairing',async()=>{
 const full=memory();await full.create('MATCH_QUEUE',{entries:Array.from({length:MATCH_QUEUE_LIMIT},(_,i)=>({key:'key'+i,expires:Date.now()+86400000,match:{code:'AB12CD34'}}))});
 assert.equal((await call(full,ticket())).status,503);assert.equal(full.data.get('MATCH_QUEUE').room.entries.length,MATCH_QUEUE_LIMIT);
 const store=memory(),a=ticket(),b=ticket(),create=store.create.bind(store);let archives=0;
 store.create=async(code,...args)=>{if(code.startsWith('MATCH_')&&code!=='MATCH_QUEUE'&&++archives===2)throw Error('temporary write failure');return create(code,...args);};
 await call(store,a);assert.equal((await call(store,b)).status,400);assert.equal(store.data.get('MATCH_QUEUE').room.entries.length,2);
 const recovered=await call(store,b);assert.equal(recovered.status,'matched');assert.equal((await call(store,a)).code,recovered.code);assert.equal(store.data.get('MATCH_QUEUE').room.entries.length,0);
});
