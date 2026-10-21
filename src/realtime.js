import {api,D1Store,hash,settle,view} from './api.js';
import {ROOM_UPDATE_PROTOCOL,encodeRoomUpdate} from '../public/room-updates.js';
import {BODY_LIMIT,securityError} from './security.js';
import {quotaFromFailure,quotaFromPayload} from '../public/service-errors.js';

// These objects retain sockets through hibernation, but never run a polling timer.
class Channel {
 constructor(ctx,env){
  this.ctx=ctx;this.env=env;this.tail=Promise.resolve();this.authTimers=new Map();
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
 }
 run(fn){const result=this.tail.then(fn);this.tail=result.catch(()=>{});return result;}
 store(key){const store=new D1Store(this.env.DB);store.trackPresence=false;store.authKey=key;return store;}
 sockets(){return this.ctx.getWebSockets().filter(ws=>ws.readyState===1);}
 send(ws,message){try{ws.send(JSON.stringify(message));}catch{ws.close(1011,'再接続してください');}}
 reportQuota(quota,source,id){
  this.quotaReportedAt=Date.now();
  for(const ws of this.sockets())if(ws===source||ws.deserializeAttachment()?.key)this.send(ws,{...(ws===source?{id}:{}),...quota});
 }
 async remember(code){this.code=code;if(await this.ctx.storage.get('code')!==code)await this.ctx.storage.put('code',code);}
 async codeValue(){return this.code||=await this.ctx.storage.get('code');}
 upgrade(request,code){
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  const origin=request.headers.get('Origin');
  if(origin&&origin!==new URL(request.url).origin)return new Response('Forbidden',{status:403});
  const ip=request.headers.get('CF-Connecting-IP')||'local',sockets=this.sockets();
  const maximum=code==='queue'?128:12;
  if(sockets.length>=maximum||sockets.filter(ws=>ws.deserializeAttachment()?.ip===ip).length>=6)return securityError(429,'接続数が上限に達しました。少し待ってからお試しください。');
  const [client,server]=Object.values(new WebSocketPair());
  this.ctx.acceptWebSocket(server);server.serializeAttachment({code,ip,authBy:Date.now()+10000});
  // Keep only the brief unauthenticated handshake awake, without persistent writes.
  this.authTimers.set(server,setTimeout(()=>{this.authTimers.delete(server);if(!server.deserializeAttachment()?.key)server.close(1008,'認証が必要です');},10000));
  return new Response(null,{status:101,webSocket:client});
 }
 authenticated(ws,key){
  if(this.sockets().filter(other=>other!==ws&&other.deserializeAttachment()?.key===key).length>=4)throw Error('同じ参加情報での接続数が上限に達しました。');
  clearTimeout(this.authTimers.get(ws));this.authTimers.delete(ws);
 }
 async closeUnauthenticated(){for(const ws of this.sockets()){const a=ws.deserializeAttachment();if(!a?.key&&a?.authBy<=Date.now())ws.close(1008,'認証が必要です');}}
 async setNextAlarm(times){
  const next=times.length?Math.max(Date.now()+1,Math.min(...times)):null;
  if(await this.ctx.storage.getAlarm()!==next){if(next===null)await this.ctx.storage.deleteAlarm();else await this.ctx.storage.setAlarm(next);}
 }
 webSocketMessage(ws,raw){
  if(typeof raw!=='string'||raw.length>BODY_LIMIT||new TextEncoder().encode(raw).byteLength>BODY_LIMIT){ws.close(1009,'メッセージが大きすぎます');return;}
  return this.run(async()=>{
  if(ws.readyState!==1)return;
  let message;
  try{
   const attachment=ws.deserializeAttachment()||{},now=Date.now();
   const window=attachment.rate?.until>now?attachment.rate:{count:0,until:now+10000};
   // Attachment counters survive hibernation and do not write D1 or DO storage.
   if(++window.count>100){ws.close(1008,'操作回数の上限');throw Error('操作が集中しています。');}
   ws.serializeAttachment({...attachment,rate:window});
   message=JSON.parse(raw);
   if(!message||typeof message.id!=='string'||message.id.length>80)throw Error('不正なメッセージです。');
   if(attachment.code==='queue'||message.action==='sync'){
    const reads=attachment.readRate?.until>now?attachment.readRate:{count:0,until:now+10000};
    if(++reads.count>10){ws.close(1008,'操作回数の上限');throw Error('操作が集中しています。');}
    ws.serializeAttachment({...ws.deserializeAttachment(),readRate:reads});
   }
   await this.message(ws,message);
  }catch(error){const quota=quotaFromFailure(error);if(quota)this.reportQuota(quota,ws,message?.id);else this.send(ws,{id:message?.id,error:error.message||'処理できませんでした。'});if(!ws.deserializeAttachment()?.key)ws.close(1008,'認証が必要です');}
 });}
 webSocketClose(ws,code){clearTimeout(this.authTimers.get(ws));this.authTimers.delete(ws);return this.run(async()=>{try{ws.close(code===1005?1000:code,'');}catch{}if(ws.deserializeAttachment()?.key&&!(this.quotaReportedAt>Date.now()-60000))await this.disconnected(ws);});}
 webSocketError(ws){clearTimeout(this.authTimers.get(ws));this.authTimers.delete(ws);return this.run(async()=>{try{ws.close(1011,'再接続してください');}catch{}if(ws.deserializeAttachment()?.key&&!(this.quotaReportedAt>Date.now()-60000))await this.disconnected(ws);});}
 async authenticate(ws,message){
  if(typeof message.token!=='string'||message.token.length<32||message.token.length>200)throw Error('参加情報がありません。');
  return await hash(message.token);
 }
}

export class RoomChannel extends Channel {
 async sendState(ws,data,envelope={},forceSnapshot=false){
  const attachment=ws.deserializeAttachment();
  if(attachment?.protocol!==ROOM_UPDATE_PROTOCOL){this.send(ws,{...envelope,data});return;}
  const {cursor,update}=await encodeRoomUpdate(attachment.updateCursor,data,forceSnapshot);
  ws.serializeAttachment({...attachment,updateCursor:cursor});
  this.send(ws,{...envelope,update});
 }
 fetch(request){return this.run(async()=>{
  const code=new URL(request.url).pathname.match(/^\/api\/rooms\/([A-F0-9]{8})/)?.[1];
  if(!code)return new Response('Not found',{status:404});
  this.code=code;
  if(new URL(request.url).pathname.endsWith('/socket'))return this.upgrade(request,code);
  const response=await api(request,this.store());
  const data=await response.json();
  if(response.ok){await this.remember(code);await this.broadcast();await this.schedule();data.transport='websocket';data.presence=this.presence(await this.record());}
  return Response.json(data,{status:response.status,headers:{'Cache-Control':'no-store'}});
 });}
 async record(){return (await this.store().get(await this.codeValue()))?.room;}
 presence(room){return room?.keys.map((key,side)=>!key?'waiting':this.sockets().some(ws=>ws.deserializeAttachment()?.side===side)?'online':'disconnected');}
 async broadcast(exclude){
  const room=await this.record();if(!room)return;
  const presence=this.presence(room);
  for(const ws of this.sockets()){
   const a=ws.deserializeAttachment();if(!a?.key||ws===exclude)continue;
   await this.sendState(ws,{...view(room,a.side),presence,transport:'websocket'},{type:'state'});
  }
 }
 async message(ws,message){
  const code=await this.codeValue();let attachment=ws.deserializeAttachment();
  if(message.action==='auth'){
   if(attachment?.key)throw Error('認証済みです。');
   const key=await this.authenticate(ws,message),room=await this.record(),side=room?.keys.indexOf(key)??-1;
   if(side<0){this.send(ws,{id:message.id,error:'このルームへの参加情報がありません。'});ws.close(1008,'認証失敗');return;}
   this.authenticated(ws,key);await this.remember(code);
   attachment={...attachment,code,key,side,...(message.protocol===ROOM_UPDATE_PROTOCOL?{protocol:ROOM_UPDATE_PROTOCOL}:{})};ws.serializeAttachment(attachment);
  }else if(!attachment?.key)throw Error('認証が必要です。');
  if(!['auth','sync','ready','plan','resign'].includes(message.action))throw Error('許可されていない操作です。');
  const read=message.action==='auth'||message.action==='sync';
  const response=await api(new Request('https://room/api/rooms/'+code+(read?'':'/'+message.action),{
   method:read?'GET':'POST',...(read?{}:{body:JSON.stringify(message.body||{})})
  }),this.store(attachment.key));
  const data=await response.json();
  if(response.ok){data.presence=this.presence(await this.record());data.transport='websocket';await this.sendState(ws,data,{id:message.id},read);await this.broadcast(ws);await this.schedule();}
  else{const quota=quotaFromPayload(data);if(quota)this.reportQuota(quota,ws,message.id);else{this.send(ws,{id:message.id,error:data.error});await this.schedule();}}
 }
 async schedule(){
  const room=await this.record(),times=[];
  // No recurring writes for abandoned games. Reconnection settles elapsed time.
  if(room?.joined&&room.game.winner===null&&this.sockets().some(ws=>ws.deserializeAttachment()?.key)){
   for(let side=0;side<2;side++){
    if(room.plans[side]!==null)continue;
    const deadline=room.deadlines?.[side]??room.deadline;
    times.push(deadline??room.readyBy??Date.now()+10000);
   }
  }
  await this.setNextAlarm(times);
 }
 alarm(){return this.run(async()=>{
  try{
  await this.closeUnauthenticated();const code=await this.codeValue(),store=this.store(),record=await store.get(code);
  if(record&&settle(record.room,Date.now())){
   record.room.version=record.revision+1;
   if(!await store.save(code,record.room,record.revision))throw Error('Concurrent alarm update');
   await this.broadcast();
  }
  await this.schedule();
  }catch(error){const quota=quotaFromFailure(error);if(!quota)throw error;this.reportQuota(quota);}
 });}
 async disconnected(){await this.broadcast();await this.schedule();}
}

export class MatchChannel extends Channel {
 waitingKeys(){return this.sockets().map(ws=>ws.deserializeAttachment()?.key).filter(Boolean);}
 matchStore(key){const store=this.store(key);store.waitingKeys=this.waitingKeys();return store;}
 async invoke(key,cancel=false){
  const response=await api(new Request('https://queue/api/matchmaking'+(cancel?'/cancel':''),{method:'POST',body:'{}'}),this.matchStore(key));
  const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),quotaFromPayload(data)||{});return {...data,transport:'websocket'};
 }
 async notify(exclude,match){
  if(match?.status!=='matched')return;
  const room=(await this.store().get(match.code))?.room;if(!room)return;
  for(const ws of this.sockets()){
   const a=ws.deserializeAttachment();if(!a?.key||ws===exclude||!room.keys.includes(a.key))continue;
   this.send(ws,{type:'state',data:await this.invoke(a.key)});
  }
 }
 fetch(request){return this.run(async()=>{
  if(new URL(request.url).pathname.endsWith('/socket'))return this.upgrade(request,'queue');
  const response=await api(request,this.matchStore());const data=await response.json();
  if(response.ok){data.transport='websocket';await this.notify(null,data);}
  return Response.json(data,{status:response.status,headers:{'Cache-Control':'no-store'}});
 });}
 async message(ws,message){
  let key=ws.deserializeAttachment()?.key;
  if(message.action==='auth'){if(key)throw Error('認証済みです。');key=await this.authenticate(ws,message);this.authenticated(ws,key);ws.serializeAttachment({...ws.deserializeAttachment(),key});}
  if(!key)throw Error('認証が必要です。');
  if(!['auth','join','sync','cancel'].includes(message.action))throw Error('許可されていない操作です。');
  const data=await this.invoke(key,message.action==='cancel');
  this.send(ws,{id:message.id,data});await this.notify(ws,data);
 }
 async disconnected(ws){const key=ws.deserializeAttachment()?.key;if(key&&!this.waitingKeys().includes(key))await this.invoke(key,true);await this.setNextAlarm([]);}
 alarm(){return this.run(async()=>{await this.closeUnauthenticated();await this.setNextAlarm([]);});}
}
