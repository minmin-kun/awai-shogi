import {api,D1Store} from './api.js';
import {guardRequest,secured,securityError,quotaErrorResponse} from './security.js';
import {cleanupExpired} from './maintenance.js';

export default {async fetch(request,env){
 try{return secured(await route(request,env));}
 catch(error){return secured(quotaErrorResponse(error)||securityError(503,'サーバーに接続できません。少し待ってからお試しください。'));}
},async scheduled(_event,env){await cleanupExpired(env.DB);}};
async function route(request,env){
 const path=new URL(request.url).pathname;
 if(path.startsWith('/api/')){
  const denied=await guardRequest(request,env);if(denied)return denied;
  if(env.ROOMS){
   const room=path.match(/^\/api\/rooms\/([A-F0-9]{8})(?:\/|$)/);
   if(room)return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
   if(path==='/api/matchmaking'||path==='/api/matchmaking/cancel'||path==='/api/matchmaking/socket')return env.MATCHES.get(env.MATCHES.idFromName('queue')).fetch(request);
  }
  if(!env.DB)return securityError(503,'対局サーバーの準備ができていません。');
  const response=await api(request,new D1Store(env.DB));
  if(env.ROOMS&&response.ok)return Response.json({...await response.json(),transport:'websocket'},{status:response.status,headers:{'Cache-Control':'no-store'}});
  return response;
 }
 if(env.ASSETS)return env.ASSETS.fetch(request);
 const asset=assets[path];return asset?new Response(asset.body,{headers:{'Content-Type':asset.type+'; charset=utf-8'}}):new Response('Not found',{status:404});
}
