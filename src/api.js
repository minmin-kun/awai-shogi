import {initial,validatePlan,resolve} from './engine.js';
const fail=(text,status=400)=>{const e=new Error(text);e.status=status;throw e;};
const token=()=>crypto.randomUUID()+crypto.randomUUID();
export const hash=async t=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function prepareRound(room,now){room.deadlines=[null,null];room.readyBy=now+10000;room.deadline=null;}
export function settle(room,now){
 if(!room.joined||room.game.winner!==null)return false;
 // Preserve the running clock of rooms created by the previous version.
 if(!room.deadlines){room.deadlines=[room.deadline,room.deadline];room.readyBy=now+10000;}
 let changed=false;
 for(let side=0;side<2;side++){
  // A disconnected client cannot hold the game at the animation barrier forever.
  if(room.deadlines[side]===null&&now>=room.readyBy){room.deadlines[side]=room.readyBy+30000;changed=true;}
  if(room.plans[side]===null&&room.deadlines[side]!==null&&now>=room.deadlines[side]){room.plans[side]=[];changed=true;}
 }
 if(room.plans.every(p=>p!==null)){room.game=resolve(room.game,room.plans);room.plans=[null,null];prepareRound(room,now);changed=true;}
 return changed;
}
function presence(r,now){return r.keys.map((key,side)=>!key?'waiting':r.lastSeen?.[side]==null?'unknown':now-r.lastSeen[side]<=12000?'online':'disconnected');}
function touch(r,side,now){if(!r.lastSeen)r.lastSeen=[null,null];if(r.lastSeen[side]===null||now-r.lastSeen[side]>=3000){r.lastSeen[side]=now;return true;}return false;}
export function view(r,side){const now=Date.now();return {code:r.code,random:!!r.random,version:r.version||0,side,game:r.game,joined:r.joined,ready:r.plans.map(p=>p!==null),ownPlan:r.plans[side],deadline:r.deadlines?r.deadlines[side]:r.deadline,presence:presence(r,now),serverTime:now};}
// One persistent CAS record serializes pairing and cancellation across workers.
// Only hashes are stored; a queue token also authenticates its assigned room.
async function matchmaking(request,store){
 const cancel=new URL(request.url).pathname.endsWith('/cancel');
 if(request.method!=='POST')fail('許可されていない操作です。',405);
 const auth=request.headers.get('Authorization')?.replace(/^Bearer /,'');
 if(!store.authKey&&(!auth||auth.length<32||auth.length>200))fail('マッチングの参加情報がありません。',403);
 const key=store.authKey||await hash(auth),queueCode='MATCH_QUEUE';
 for(let attempt=0;attempt<32;attempt++){
  let record=await store.get(queueCode);
  if(!record){try{await store.create(queueCode,{entries:[]});}catch{if(!await store.get(queueCode))throw new Error('queue creation failed');}continue;}
  const now=Date.now(),queue=record.room;
  queue.entries=queue.entries.filter(e=>e.expires>now||(!e.match&&store.waitingKeys?.includes(e.key)));
  let own=queue.entries.find(e=>e.key===key);
  if(own?.match){
   const m=own.match;let found=await store.get(m.code);
   if(!found){
    const room={code:m.code,game:initial(),joined:true,keys:m.keys,plans:[null,null],deadline:null,lastSeen:[null,null],random:true};prepareRound(room,now);
    try{await store.create(m.code,room);}catch{if(!await store.get(m.code))throw new Error('match creation failed');}
    found=await store.get(m.code);
   }
   return json({status:'matched',...view(found.room,m.side)});
  }
  if(cancel){queue.entries=queue.entries.filter(e=>e.key!==key);}
  else{
   if(!own){own={key,expires:now+20000};queue.entries.push(own);}
   own.expires=now+20000;
   const peer=queue.entries.find(e=>e!==own&&!e.match);
   if(peer){
    const side=crypto.getRandomValues(new Uint8Array(1))[0]%2,keys=[];keys[side]=key;keys[1-side]=peer.key;
    const code=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
    own.match={code,keys,side};peer.match={code,keys,side:1-side};own.expires=peer.expires=now+86400000;
   }
  }
  if(await store.save(queueCode,queue,record.revision)){
   if(own?.match)continue;
   return json({status:cancel?'cancelled':'waiting'});
  }
 }
 fail('参加が集中しています。もう一度お試しください。',409);
}
export async function api(request,store){
 try{
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/matchmaking'||path==='/api/matchmaking/cancel')return await matchmaking(request,store);
  if(request.method==='POST'&&path==='/api/rooms'){
   const input=await request.json();const code=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase(),t=token();
   const side=input.side===1?1:0;const room={code,game:initial(),joined:false,keys:[null,null],plans:[null,null],deadline:null,lastSeen:[null,null]};room.keys[side]=await hash(t);touch(room,side,Date.now());
   await store.create(code,room);return json({...view(room,side),token:t},201);
  }
  const match=path.match(/^\/api\/rooms\/([A-F0-9]{8})(\/join|\/ready|\/plan|\/resign)?$/);if(!match)fail('ルームが見つかりません。',404);
  const code=match[1],action=match[2]||'';
  if(request.method!=='GET'&&request.method!=='POST')fail('許可されていない操作です。',405);
  const input=request.method==='POST'?await request.json():null;
  const auth=request.headers.get('Authorization')?.replace(/^Bearer /,'');const key=store.authKey||(auth?await hash(auth):null);
  const joinToken=action==='/join'?token():null;const joinKey=joinToken?await hash(joinToken):null;
  for(let attempt=0;attempt<12;attempt++){
   const record=await store.get(code);if(!record)fail('ルームが見つかりません。有効期限は24時間です。',404);
   const r=record.room;let side=key?r.keys.indexOf(key):-1;let changed=false;
   if(action==='/join'&&request.method==='POST'){
    if(r.joined)fail('このルームはすでに対局中です。',409);
    side=r.keys.indexOf(null);r.keys[side]=joinKey;r.joined=true;touch(r,side,Date.now());prepareRound(r,Date.now());changed=true;
   }else{
    if(side<0)fail('このルームへの参加情報がありません。',403);
    changed=settle(r,Date.now());
    if(store.trackPresence!==false)changed=touch(r,side,Date.now())||changed;
    if(action==='/ready'&&request.method==='POST'){
     if(!r.joined||r.game.winner!==null)fail('対局を開始できません。',409);
     if(input.round!==r.game.round)fail('ターンが進みました。盤面を確認してください。',409);
     if(r.deadlines[side]===null){r.deadlines[side]=Date.now()+30000;changed=true;}
    }else if(action==='/plan'&&request.method==='POST'){
     if(!r.joined||r.game.winner!==null)fail('対局を開始できません。',409);
     if(input.round!==r.game.round){if(changed){r.version=record.revision+1;if(await store.save(code,r,record.revision))return json(view(r,side));}fail('ターンが進みました。盤面を確認してください。',409);}
     if(r.deadlines[side]===null)fail('盤面の表示準備が完了していません。',409);
     if(r.plans[side]!==null)fail('このターンは確定済みです。',409);
     r.plans[side]=validatePlan(r.game,side,input.plan);changed=true;settle(r,Date.now());
    }else if(action==='/resign'&&request.method==='POST'){
     if(!r.joined||r.game.winner!==null)fail('対局中のみ投了できます。',409);
     r.game.winner=1-side;r.game.resigned=side;changed=true;
    }else if(action||request.method!=='GET')fail('許可されていない操作です。',405);
   }
   if(changed)r.version=record.revision+1;
   if(!changed||await store.save(code,r,record.revision))return json({...view(r,side),...(joinToken?{token:joinToken}:{})});
  }
  fail('操作が重なりました。もう一度お試しください。',409);
 }catch(e){return json({error:e.status?e.message:(e.message?.includes('指し手')||e.message?.includes('二度打ち')||e.message?.includes('選べない')?e.message:'処理できませんでした。再度お試しください。')},e.status||400);}
}
export class D1Store{
 constructor(db){this.db=db;}
 async create(code,room){await this.db.prepare('INSERT INTO rooms (code, data, revision, expires) VALUES (?, ?, 0, ?)').bind(code,JSON.stringify(room),(code==='MATCH_QUEUE'?Number.MAX_SAFE_INTEGER:Date.now()+86400000)).run();}
 async get(code){const r=await this.db.prepare('SELECT data, revision FROM rooms WHERE code = ? AND expires > ?').bind(code,Date.now()).first();return r?{room:JSON.parse(r.data),revision:r.revision}:null;}
 async save(code,room,revision){const r=await this.db.prepare('UPDATE rooms SET data = ?, revision = revision + 1 WHERE code = ? AND revision = ?').bind(JSON.stringify(room),code,revision).run();return r.meta.changes===1;}
}
