import {api,D1Store,hash,settle,view} from './api.js';

// These objects retain sockets through hibernation, but never run a polling timer.
class Channel {
 constructor(ctx,env){
  this.ctx=ctx;this.env=env;this.tail=Promise.resolve();
  ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
 }
 run(fn){const result=this.tail.then(fn);this.tail=result.catch(()=>{});return result;}
 store(key){const store=new D1Store(this.env.DB);store.trackPresence=false;store.authKey=key;return store;}
 sockets(){return this.ctx.getWebSockets().filter(ws=>ws.readyState===1);}
 send(ws,message){try{ws.send(JSON.stringify(message));}catch{ws.close(1011,'再接続してください');}}
 async remember(code){this.code=code;if(await this.ctx.storage.get('code')!==code)await this.ctx.storage.put('code',code);}
 async codeValue(){return this.code||=await this.ctx.storage.get('code');}
 upgrade(request,code){
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  const origin=request.headers.get('Origin');
  if(origin&&origin!==new URL(request.url).origin)return new Response('Forbidden',{status:403});
  const [client,server]=Object.values(new WebSocketPair());
  this.ctx.acceptWebSocket(server);server.serializeAttachment({code,authBy:Date.now()+10000});
  return new Response(null,{status:101,webSocket:client});
 }
 async closeUnauthenticated(){for(const ws of this.sockets()){const a=ws.deserializeAttachment();if(!a?.key&&a?.authBy<=Date.now())ws.close(1008,'認証が必要です');}}
 async setNextAlarm(times){
  for(const ws of this.sockets()){const a=ws.deserializeAttachment();if(!a?.key&&a?.authBy>Date.now())times.push(a.authBy);}
  const next=times.length?Math.max(Date.now()+1,Math.min(...times)):null;
  if(await this.ctx.storage.getAlarm()!==next){if(next===null)await this.ctx.storage.deleteAlarm();else await this.ctx.storage.setAlarm(next);}
 }
 webSocketMessage(ws,raw){return this.run(async()=>{
  let message;
  try{
   if(typeof raw!=='string'||raw.length>8192)throw Error('メッセージが大きすぎます。');
   message=JSON.parse(raw);
   if(!message||typeof message.id!=='string'||message.id.length>80)throw Error('不正なメッセージです。');
   await this.message(ws,message);
  }catch(error){this.send(ws,{id:message?.id,error:error.message||'処理できませんでした。'});}
 });}
 webSocketClose(ws,code){return this.run(async()=>{try{ws.close(code===1005?1000:code,'');}catch{}await this.disconnected(ws);});}
 webSocketError(ws){return this.run(async()=>{try{ws.close(1011,'再接続してください');}catch{}await this.disconnected(ws);});}
 async authenticate(ws,message){
  if(typeof message.token!=='string'||message.token.length<32||message.token.length>200)throw Error('参加情報がありません。');
  return await hash(message.token);
 }
}

export class RoomChannel extends Channel {
 fetch(request){return this.run(async()=>{
  const code=new URL(request.url).pathname.match(/^\/api\/rooms\/([A-F0-9]{8})/)?.[1];
  if(!code)return new Response('Not found',{status:404});
  await this.remember(code);
  if(new URL(request.url).pathname.endsWith('/socket')){const response=this.upgrade(request,code);await this.schedule();return response;}
  const response=await api(request,this.store());
  const data=await response.json();
  if(response.ok){await this.broadcast();await this.schedule();data.transport='websocket';data.presence=this.presence(await this.record());}
  return Response.json(data,{status:response.status,headers:{'Cache-Control':'no-store'}});
 });}
 async record(){return (await this.store().get(await this.codeValue()))?.room;}
 presence(room){return room?.keys.map((key,side)=>!key?'waiting':this.sockets().some(ws=>ws.deserializeAttachment()?.side===side)?'online':'disconnected');}
 async broadcast(exclude){
  const room=await this.record();if(!room)return;
  const presence=this.presence(room);
  for(const ws of this.sockets()){
   const a=ws.deserializeAttachment();if(!a?.key||ws===exclude)continue;
   this.send(ws,{type:'state',data:{...view(room,a.side),presence,transport:'websocket'}});
  }
 }
 async message(ws,message){
  const code=await this.codeValue();let attachment=ws.deserializeAttachment();
  if(message.action==='auth'){
   const key=await this.authenticate(ws,message),room=await this.record(),side=room?.keys.indexOf(key)??-1;
   if(side<0){this.send(ws,{id:message.id,error:'このルームへの参加情報がありません。'});ws.close(1008,'認証失敗');return;}
   attachment={code,key,side};ws.serializeAttachment(attachment);
  }else if(!attachment?.key)throw Error('認証が必要です。');
  if(!['auth','sync','ready','plan','resign'].includes(message.action))throw Error('許可されていない操作です。');
  const read=message.action==='auth'||message.action==='sync';
  const response=await api(new Request('https://room/api/rooms/'+code+(read?'':'/'+message.action),{
   method:read?'GET':'POST',...(read?{}:{body:JSON.stringify(message.body||{})})
  }),this.store(attachment.key));
  const data=await response.json();
  if(response.ok){data.presence=this.presence(await this.record());data.transport='websocket';this.send(ws,{id:message.id,data});await this.broadcast(ws);await this.schedule();}
  else{this.send(ws,{id:message.id,error:data.error});await this.schedule();}
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
  await this.closeUnauthenticated();const code=await this.codeValue(),store=this.store(),record=await store.get(code);
  if(record&&settle(record.room,Date.now())){
   record.room.version=record.revision+1;
   if(!await store.save(code,record.room,record.revision))throw Error('Concurrent alarm update');
   await this.broadcast();
  }
  await this.schedule();
 });}
 async disconnected(){await this.broadcast();await this.schedule();}
}

export class MatchChannel extends Channel {
 waitingKeys(){return this.sockets().map(ws=>ws.deserializeAttachment()?.key).filter(Boolean);}
 matchStore(key){const store=this.store(key);store.waitingKeys=this.waitingKeys();return store;}
 async invoke(key,cancel=false){
  const response=await api(new Request('https://queue/api/matchmaking'+(cancel?'/cancel':''),{method:'POST',body:'{}'}),this.matchStore(key));
  const data=await response.json();if(!response.ok)throw Error(data.error);return {...data,transport:'websocket'};
 }
 async notify(exclude){
  for(const ws of this.sockets()){
   const a=ws.deserializeAttachment();if(!a?.key||ws===exclude)continue;
   this.send(ws,{type:'state',data:await this.invoke(a.key)});
  }
 }
 fetch(request){return this.run(async()=>{
  if(new URL(request.url).pathname.endsWith('/socket')){const response=this.upgrade(request,'queue');await this.setNextAlarm([]);return response;}
  const response=await api(request,this.matchStore());const data=await response.json();
  if(response.ok){data.transport='websocket';await this.notify();}
  return Response.json(data,{status:response.status,headers:{'Cache-Control':'no-store'}});
 });}
 async message(ws,message){
  let key=ws.deserializeAttachment()?.key;
  if(message.action==='auth'){key=await this.authenticate(ws,message);ws.serializeAttachment({key});}
  if(!key)throw Error('認証が必要です。');
  if(!['auth','join','sync','cancel'].includes(message.action))throw Error('許可されていない操作です。');
  const data=await this.invoke(key,message.action==='cancel');
  this.send(ws,{id:message.id,data});await this.notify(ws);await this.setNextAlarm([]);
 }
 async disconnected(ws){const key=ws.deserializeAttachment()?.key;if(key&&!this.waitingKeys().includes(key))await this.invoke(key,true);await this.setNextAlarm([]);}
 alarm(){return this.run(async()=>{await this.closeUnauthenticated();await this.setNextAlarm([]);});}
}
