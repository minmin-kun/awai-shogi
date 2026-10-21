import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {boundedBody,smallJson,guardRequest,takeLocal,secured,SECURITY_HEADERS} from '../src/security.js';
import {api} from '../src/api.js';
import {RoomChannel} from '../src/realtime.js';

test('streamed bodies enforce bytes without trusting Content-Length',async()=>{
 let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('あ'.repeat(3000)));},cancel(){cancelled=true;}});
 const request=new Request('http://localhost/api/rooms',{method:'POST',duplex:'half',body:stream});
 await assert.rejects(boundedBody(request),{status:413});assert(cancelled);
 assert.equal((await boundedBody(new Request('http://localhost',{method:'POST',body:' '.repeat(8192)}))).byteLength,8192);
 await assert.rejects(boundedBody(new Request('http://localhost',{method:'POST',headers:{'Content-Length':'9000'},body:'{}'})),{status:413});
 await assert.rejects(boundedBody(new Request('http://localhost',{method:'POST',headers:{'Content-Encoding':'gzip'},body:'{}'})),{status:415});
});
test('bad JSON shapes and oversized API input cannot write room or queue state',async()=>{
 let writes=0;const store={async create(){writes++;},async get(){throw Error('must reject before database reads');}};
 for(const path of ['/api/rooms','/api/matchmaking','/api/rooms/DEADBEEF/join']){
  const result=await api(new Request('http://localhost'+path,{method:'POST',body:JSON.stringify({padding:'a'.repeat(9000)})}),store);assert.equal(result.status,413);
 }
 for(const value of ['null','[]','true','"text"','{bad'])await assert.rejects(smallJson(new Request('http://localhost',{method:'POST',body:value})),{status:400});
 assert.equal(writes,0);
});
test('HTTP limits use shared binding counters and independent action keys',async()=>{
 const seen=[];const limiter={async limit({key}){seen.push(key);return {success:false};}};
 const response=await guardRequest(new Request('https://play.example/api/rooms',{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1'}}),{RATE_API:{async limit(){return {success:true};}},RATE_CREATE:limiter});
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');assert.deepEqual(seen,['create:192.0.2.1']);
 assert.equal((await guardRequest(new Request('https://play.example/api/rooms',{headers:{Origin:'https://attacker.example'}}))).status,403);
 for(let i=0;i<3;i++)assert(takeLocal('test-budget',3,1000,100));assert(!takeLocal('test-budget',3,1000,100));assert(takeLocal('test-budget',3,1000,1100));
});
test('denied room requests never persist DO metadata or alarms',async t=>{
 const original=globalThis.WebSocketRequestResponsePair;globalThis.WebSocketRequestResponsePair=class {};
 t.after(()=>{if(original===undefined)delete globalThis.WebSocketRequestResponsePair;else globalThis.WebSocketRequestResponsePair=original;});
 let writes=0;
 const ctx={setWebSocketAutoResponse(){},getWebSockets(){return [];},storage:{async put(){writes++;},async setAlarm(){writes++;},async deleteAlarm(){writes++;}}};
 const env={DB:{prepare(){return {bind(){return {async first(){return null;}};}};}}};
 const room=new RoomChannel(ctx,env);
 assert.equal((await room.fetch(new Request('https://local/api/rooms/DEADBEEF'))).status,404);
 assert.equal((await room.fetch(new Request('https://local/api/rooms/DEADBEEF/socket'))).status,426);
 assert.equal(writes,0);
});
test('static assets and API responses share restrictive browser security headers',async()=>{
 const response=secured(Response.json({error:'no'},{status:403}));assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'no'});
 const assetHeaders=await readFile(new URL('../dist/client/_headers',import.meta.url),'utf8');
 for(const [key,value] of Object.entries(SECURITY_HEADERS)){assert.equal(response.headers.get(key),value);assert(assetHeaders.includes(`  ${key}: ${value}`));}
 assert(!SECURITY_HEADERS['Content-Security-Policy'].includes("script-src 'self' 'unsafe-inline'"));
});
