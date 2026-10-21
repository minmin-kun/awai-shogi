import {quotaFromFailure} from '../public/service-errors.js';
export const BODY_LIMIT=8192;
export function quotaErrorResponse(error){
 const quota=quotaFromFailure(error);if(!quota)return null;
 return Response.json(quota,{status:503,headers:{'Cache-Control':'no-store',...(quota.resetAt?{'Retry-After':String(Math.max(1,Math.ceil((quota.resetAt-Date.now())/1000)))}:{})}});
}
export const SECURITY_HEADERS={
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://play.awai-shogi.workers.dev ws://localhost:* ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Strict-Transport-Security':'max-age=31536000'
};
export function secured(response){
 if(response.status===101)return response;
 const headers=new Headers(response.headers);for(const [key,value] of Object.entries(SECURITY_HEADERS))headers.set(key,value);
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export function securityError(status,message){return Response.json({error:message},{status,headers:{'Cache-Control':'no-store',...(status===429?{'Retry-After':'60'}:{})}});}
function bodyError(status,message){const error=new Error(message);error.status=status;throw error;}
// Count actual streamed bytes, including requests without Content-Length.
export async function boundedBody(request){
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>BODY_LIMIT)){request.body?.cancel().catch(()=>{});bodyError(413,'送信データが大きすぎます。');}
 if(request.headers.get('Content-Encoding')&&!/^identity$/i.test(request.headers.get('Content-Encoding'))){request.body?.cancel().catch(()=>{});bodyError(415,'圧縮された送信データは受け付けていません。');}
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>BODY_LIMIT){reader.cancel().catch(()=>{});bodyError(413,'送信データが大きすぎます。');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
export async function smallJson(request){
 const bytes=await boundedBody(request);let value;
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{bodyError(400,'JSONの形式が正しくありません。');}
 if(!value||typeof value!=='object'||Array.isArray(value))bodyError(400,'JSONオブジェクトを送信してください。');return value;
}
// This fallback also protects the standalone local server. Production uses
// Cloudflare's shared per-location counters, without D1 writes.
const localLimits=new Map();
export function takeLocal(key,limit,period=60000,now=Date.now()){
 let entry=localLimits.get(key);if(!entry||entry.until<=now){entry={count:0,until:now+period};localLimits.delete(key);localLimits.set(key,entry);}
 if(localLimits.size>4096)localLimits.delete(localLimits.keys().next().value);
 return ++entry.count<=limit;
}
export async function guardRequest(request,env={}){
 const path=new URL(request.url).pathname;if(!path.startsWith('/api/'))return null;
 const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)return securityError(403,'許可されていない接続元です。');
 const ip=request.headers.get('CF-Connecting-IP')||'local';
 const checks=[['RATE_API','api',240]];
 if(path==='/api/rooms'&&request.method==='POST')checks.push(['RATE_CREATE','create',10]);
 if(path.endsWith('/socket'))checks.push(['RATE_ENTRY','connect',30]);
 else if(path.endsWith('/join')||path.startsWith('/api/matchmaking'))checks.push(['RATE_ENTRY','entry',30]);
 for(const [binding,scope,limit] of checks){const key=scope+':'+ip;const success=env[binding]?(await env[binding].limit({key})).success:takeLocal(key,limit);if(!success)return securityError(429,'操作が集中しています。少し待ってからお試しください。');}
 return null;
}
