import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaPayload,quotaFromFailure,quotaFromPayload,quotaCopy,readServiceResponse,QUOTA_CODE} from '../public/service-errors.js';
import {api} from '../src/api.js';
import {RoomChannel} from '../src/realtime.js';

test('only recognized quota failures are classified; daily reset uses UTC midnight',()=>{
 const now=Date.UTC(2026,9,22,20),payload=quotaPayload('daily',now);assert.equal(payload.resetAt,Date.UTC(2026,9,23));
 for(const kind of ['read','write'])assert.equal(quotaFromFailure(Error(`D1_ERROR: Your account has exceeded D1's free tier daily row ${kind} limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.`)).code,QUOTA_CODE);
 assert.equal(quotaFromFailure(Error('Exceeded maximum DB size.')).limit,'storage');
 for(const message of ['network error','Too many requests','D1 database unavailable','CPU limit exceeded'])assert.equal(quotaFromFailure(Error(message)),null);
 const copy=quotaCopy(payload,true);assert(copy.recovery.includes('09:00'));assert(copy.note.includes('再開できない場合'));
 assert(!quotaCopy(quotaPayload('storage'),false).recovery.includes('リセット'));assert.equal(quotaFromPayload({code:QUOTA_CODE,limit:'bogus'}),null);
});

test('HTTP quota codes and Cloudflare 1027 pages are recognized, ordinary 429/503 are not',async()=>{
 await assert.rejects(readServiceResponse(Response.json(quotaPayload(),{status:503})),{code:QUOTA_CODE});
 await assert.rejects(readServiceResponse(new Response('<h1><span>Error</span><span>1027</span></h1>',{status:429})),{code:QUOTA_CODE});
 await assert.rejects(readServiceResponse(Response.json({error:'操作が集中しています。'},{status:429})),error=>error.status===429&&!error.code);
 await assert.rejects(readServiceResponse(new Response('<h1>Error 1101</h1>',{status:503})),error=>error.status===503&&!error.code);
 assert.deepEqual(await readServiceResponse(Response.json({status:'ok'})),{status:'ok'});
});

test('D1 API failures return a safe structured quota error rather than raw infrastructure details',async()=>{
 const store={async create(){throw Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. secret internal detail");}};
 const result=await api(new Request('https://local/api/rooms',{method:'POST',body:'{}'}),store);
 assert.equal(result.status,503);assert(Number(result.headers.get('Retry-After'))>0);
 const data=await result.json();assert.equal(data.code,QUOTA_CODE);assert(!JSON.stringify(data).includes('secret'));assert.equal(data.limit,'daily');
});

test('a room quota error is sent to both authenticated players without scheduling more DB work',async t=>{
 const original=globalThis.WebSocketRequestResponsePair;globalThis.WebSocketRequestResponsePair=class {};
 t.after(()=>{if(original===undefined)delete globalThis.WebSocketRequestResponsePair;else globalThis.WebSocketRequestResponsePair=original;});
 function socket(side){let attachment={code:'DEADBEEF',side,key:String(side)};return {readyState:1,messages:[],deserializeAttachment(){return attachment;},serializeAttachment(value){attachment=value;},send(raw){this.messages.push(JSON.parse(raw));},close(){this.readyState=3;}};}
 const a=socket(0),b=socket(1);let alarmWrites=0;
 const ctx={setWebSocketAutoResponse(){},getWebSockets(){return [a,b];},storage:{async get(){return 'DEADBEEF';},async setAlarm(){alarmWrites++;},async deleteAlarm(){alarmWrites++;}}};
 const env={DB:{prepare(){return {bind(){return {async first(){throw Error("Your account has exceeded D1's free tier daily row read limit.");}};}};}}};
 const channel=new RoomChannel(ctx,env);await channel.webSocketMessage(a,JSON.stringify({id:'q',action:'sync'}));
 assert.equal(a.messages[0].code,QUOTA_CODE);assert.equal(a.messages[0].id,'q');assert.equal(b.messages[0].code,QUOTA_CODE);assert.equal(alarmWrites,0);
});
