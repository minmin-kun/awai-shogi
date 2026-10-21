import {ROOM_UPDATE_PROTOCOL,decodeRoomUpdate} from './room-updates.js';
import {quotaFromPayload,readServiceResponse,serviceError} from './service-errors.js';
// One authenticated socket replaces room polling and heartbeat database writes.
export class RealtimeChannel {
 constructor(path,token,{onState,onStatus,onQuota}={}){
  this.path=path;this.token=token;this.onState=onState;this.onStatus=onStatus;this.onQuota=onQuota;
  this.pending=new Map();this.sequence=0;this.attempt=0;this.closed=false;
  this.connect();
 }
 connect(){
  if(this.closed||this.socket?.readyState===0||this.socket?.readyState===1)return;
  clearTimeout(this.retry);this.authenticated=false;this.roomUpdateState=null;this.resyncing=false;this.onStatus?.('reconnecting');
  const url=new URL(this.path,location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const socket=this.socket=new WebSocket(url);this.lastMessage=Date.now();
  this.authReady=new Promise((resolve,reject)=>{this.resolveAuth=resolve;this.rejectAuth=reject;});
  this.authReady.catch(()=>{});
  const connectionTimeout=setTimeout(()=>socket.close(),10000);
  socket.onopen=async()=>{
   try{
    const data=await this.rpc('auth',undefined,this.token);
    if(socket!==this.socket||this.closed)return;
    clearTimeout(connectionTimeout);this.authenticated=true;this.attempt=0;
    this.resolveAuth();this.onStatus?.('online');this.onState?.(data);
    clearInterval(this.heartbeat);
    this.heartbeat=setInterval(()=>{
     if(Date.now()-this.lastMessage>45000){socket.close();return;}
     if(socket.readyState===1)socket.send('ping');
    },20000);
   }catch{socket.close();}
  };
  socket.onmessage=event=>{
   if(socket!==this.socket)return;this.lastMessage=Date.now();
   if(event.data==='pong')return;
   let message;try{message=JSON.parse(event.data);}catch{return;}
   this.receive(message);
  };
  socket.onclose=async()=>{
   clearTimeout(connectionTimeout);if(socket!==this.socket)return;
   const wasAuthenticated=this.authenticated;clearInterval(this.heartbeat);this.authenticated=false;
   const error=new Error('通信が切れました。再接続後に盤面を確認してください。');
   this.rejectAuth(error);for(const p of this.pending.values()){clearTimeout(p.timeout);p.reject(error);}this.pending.clear();
   if(this.closed)return;
   this.onStatus?.(navigator.onLine===false?'offline':'reconnecting');
   // Browsers hide the response body of a failed WebSocket handshake. A small
   // HTTP check can identify Cloudflare 1027 without replaying any game action.
   if(!wasAuthenticated&&typeof fetch==='function'){
    try{await readServiceResponse(await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(5000)}));}
    catch(error){const quota=quotaFromPayload(error);if(quota&&socket===this.socket&&!this.closed)this.haltQuota(quota);}
   }
   if(this.closed||socket!==this.socket)return;
   this.retry=setTimeout(()=>this.connect(),Math.min(15000,500*2**this.attempt++));
  };
  socket.onerror=()=>socket.close();
 }
 receive(message){
  if(this.closed)return;
  const quota=quotaFromPayload(message);if(quota){this.haltQuota(quota);return;}
  const pending=this.pending.get(message.id);
  const finish=(data,error)=>{if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timeout);if(error)pending.reject(error);else pending.resolve(data);};
  let data=message.data;
  if(message.update){
   try{
    if(this.resyncing&&message.update.type==='delta')throw Error('Waiting for room snapshot');
    const decoded=decodeRoomUpdate(this.roomUpdateState,message.update);
    if(decoded.ignored){if(pending)finish(structuredClone(decoded.state));return;}
    this.roomUpdateState=decoded;data=structuredClone(decoded.state);
    if(message.update.type==='snapshot')this.resyncing=false;
   }catch{
    finish(null,new Error('盤面を再同期しています。確定済みの指し手は再接続後に確認できます。'));
    if(!this.authenticated){this.socket.close();return;}
    if(this.resyncing){if(message.update.type==='snapshot')this.socket.close();return;}
    this.resyncing=true;
    // Do not replay a move after an uncertain response. Only fetch a snapshot.
    void this.rpc('sync').then(state=>this.onState?.(state)).catch(()=>this.socket.close()).finally(()=>{this.resyncing=false;});
    return;
   }
  }
  if(pending)finish(data,message.error?new Error(message.error):null);
  else if(message.type==='state'||message.update)this.onState?.(data);
 }
 rpc(action,body,token){
  if(this.socket?.readyState!==1)return Promise.reject(new Error('再接続中です。'));
  const id=String(++this.sequence);
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error('応答を確認できません。盤面を再同期します。'));this.socket.close();},10000);
   this.pending.set(id,{resolve,reject,timeout});
   this.socket.send(JSON.stringify({id,action,body,...(token?{token,protocol:ROOM_UPDATE_PROTOCOL}:{})}));
  });
 }
 haltQuota(quota){
  if(this.closed)return;this.quota=quota;const error=serviceError(quota,503);
  this.closed=true;this.authenticated=false;clearTimeout(this.retry);clearInterval(this.heartbeat);
  this.rejectAuth(error);for(const pending of this.pending.values()){clearTimeout(pending.timeout);pending.reject(error);}this.pending.clear();
  this.socket?.close(1000,'利用上限');this.onStatus?.('quota');this.onQuota?.(quota);
 }
 async call(action,body){if(this.quota)throw serviceError(this.quota,503);if(this.closed)throw Error('接続は終了しました。');if(!this.authenticated)await this.authReady;return this.rpc(action,body);}
 async resume(){
  if(this.closed)return;
  if(this.authenticated){try{this.onState?.(await this.call('sync'));}catch{}}
  else if(this.socket?.readyState!==0)this.connect();
 }
 close(){this.closed=true;clearTimeout(this.retry);clearInterval(this.heartbeat);this.socket?.close(1000,'');}
}
