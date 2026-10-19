export const LABELS={K:'王',R:'飛',B:'角',G:'金',S:'銀',N:'桂',L:'香',P:'歩', '+R':'龍','+B':'馬','+S':'全','+N':'圭','+L':'杏','+P':'と'};
export const HAND=['R','B','G','S','N','L','P'];
export function initial(){
 const board=Array(81).fill(null);let id=0;
 const put=(r,c,t,s)=>board[r*9+c]={id:++id,t,s};
 for(let s=0;s<2;s++){
  const home=s===0?8:0, pawn=s===0?6:2;
  ['L','N','S','G','K','G','S','N','L'].forEach((t,c)=>put(home,c,t,s));
  for(let c=0;c<9;c++)put(pawn,c,'P',s);
  put(s===0?7:1,s===0?1:7,'B',s);put(s===0?7:1,s===0?7:1,'R',s);
 }
 return {board,hands:[{},{}],leader:0,initialSecond:1,doubleUsed:false,round:1,winner:null,history:[],last:[],nextId:41};
}
export const clone=s=>JSON.parse(JSON.stringify(s));
export const zone=(i,s)=>s===0?Math.floor(i/9)<3:Math.floor(i/9)>5;
export function canPromote(p,from,to){return !p.t.startsWith('+')&&'RBSNLP'.includes(p.t)&&(zone(from,p.s)||zone(to,p.s));}
export function forced(p,to){let rank=p.s===0?Math.floor(to/9):8-Math.floor(to/9);return (['P','L'].includes(p.t)&&rank===0)||(p.t==='N'&&rank<2);}
export function legal(s,side,m){
 if(!m||!Number.isInteger(m.to)||m.to<0||m.to>80)return false;
 const target=s.board[m.to];if(target?.s===side)return false;
 if(m.drop){
  if(!HAND.includes(m.drop)||!(s.hands[side][m.drop]>0)||target)return false;
  const p={t:m.drop,s:side};if(forced(p,m.to))return false;
  if(m.drop==='P'&&s.board.some((p,i)=>p?.s===side&&p.t==='P'&&i%9===m.to%9))return false;
  return true;
 }
 if(!Number.isInteger(m.from)||m.from<0||m.from>80||m.from===m.to)return false;
 const p=s.board[m.from];if(!p||p.s!==side||(m.id!=null&&p.id!==m.id))return false;
 if(m.promote&&!canPromote(p,m.from,m.to))return false;
 const dx=m.to%9-m.from%9,dy=(Math.floor(m.to/9)-Math.floor(m.from/9))*(side===0?-1:1), ax=Math.abs(dx),ay=Math.abs(dy);
 let step=false,slide=false;
 if(p.t==='K')step=ax<=1&&ay<=1;
 if(['G','+S','+N','+L','+P'].includes(p.t))step=(dy===1&&ax<=1)||(dy===0&&ax===1)||(dy===-1&&dx===0);
 if(p.t==='S')step=(dy===1&&ax<=1)||(dy===-1&&ax===1);
 if(p.t==='N')step=dy===2&&ax===1;
 if(p.t==='P')step=dy===1&&dx===0;
 if(p.t==='L')slide=dy>0&&dx===0;
 if(p.t==='R'||p.t==='+R'){slide=(dx===0||dy===0);if(p.t==='+R')step=ax===1&&ay===1;}
 if(p.t==='B'||p.t==='+B'){slide=ax===ay;if(p.t==='+B')step=ax+ay===1;}
 if(step)return true;if(!slide)return false;
 const col=Math.sign(dx),row=Math.sign(Math.floor(m.to/9)-Math.floor(m.from/9));
 for(let c=m.from%9+col,r=Math.floor(m.from/9)+row;r*9+c!==m.to;c+=col,r+=row){if(s.board[r*9+c])return false;}
 return true;
}
export function moves(s,side){const a=[];s.board.forEach((p,from)=>{if(p?.s!==side)return;for(let to=0;to<81;to++){let m={from,to,id:p.id};if(legal(s,side,m)){if(canPromote(p,from,to))m.promote=true;a.push(m);}}});for(const t of HAND)if(s.hands[side][t])for(let to=0;to<81;to++){const m={drop:t,to};if(legal(s,side,m))a.push(m);}return a;}
export function apply(s,side,m){
 if(!legal(s,side,m))return {ok:false,capture:false};
 let p;
 if(m.drop){s.hands[side][m.drop]--;p={id:s.nextId++,t:m.drop,s:side};}
 else {p=s.board[m.from];s.board[m.from]=null;}
 const captured=s.board[m.to];
 if(captured){if(captured.t==='K')s.winner=side;else{const t=captured.t.replace('+','');s.hands[side][t]=(s.hands[side][t]||0)+1;}}
 const name=LABELS[p.t];if(!m.drop&&(m.promote||forced(p,m.to)))p={...p,t:'+'+p.t};s.board[m.to]=p;
 return {ok:true,capture:!!captured,name,promoted:name!==LABELS[p.t]};
}
export function validatePlan(s,side,plan){
 if(!Array.isArray(plan)||plan.length>2)throw new Error('指し手を確認してください。');
 if(plan.length===2&&(side!==s.initialSecond||s.doubleUsed))throw new Error('二度打ちは開始後手が一度だけ使えます。');
 const copy=clone(s);const normalized=[];
 for(const raw of plan){const m={to:raw.to};if(raw.drop)m.drop=raw.drop;else {m.from=raw.from;m.id=copy.board[m.from]?.id;m.promote=raw.promote===true;}
  if(!apply(copy,side,m).ok)throw new Error('選べない指し手です。');normalized.push(m);}
 return normalized;
}
export function resolve(state,plans){
 const s=clone(state),leader=s.leader;let swap=false;const events=[];
 if(plans[s.initialSecond].length===2)s.doubleUsed=true;
 for(const side of [leader,1-leader]){
  if(!plans[side].length)events.push({side,text:'パス',ok:true});
  for(const m of plans[side]){
   if(s.winner!==null)break;
   const result=apply(s,side,m);if(side===leader&&result.capture)swap=true;
   const file=9-m.to%9,rank='一二三四五六七八九'[Math.floor(m.to/9)];
   events.push({side,...m,...result,text:result.ok?`${file}${rank}${result.name}${m.drop?'打':''}${result.promoted?'成':''}${result.capture?'・取':''}`:'予約手が不発'});
  }
 }
 s.last=events;s.history.push({round:s.round,leader,events,swap});if(swap)s.leader=1-leader;s.round++;return s;
}
export function cpuPlan(s,side){
 const values={K:100000,R:900,B:800,G:500,S:400,N:280,L:250,P:100};
 let list=moves(s,side);if(!list.length)return [];
 const enemies=moves(s,1-side);let best=null,score=-Infinity;
 for(const m of list){const p=m.drop?{t:m.drop,s:side}:s.board[m.from];const dest=s.board[m.to];const danger=enemies.some(e=>e.to===m.to);const forward=m.drop?0:(Math.floor(m.to/9)-Math.floor(m.from/9))*(side===0?-1:1);
  const n=(dest?values[dest.t.replace('+','')]*1.5:0)-(danger?values[p.t.replace('+','')]*0.9:0)+(m.promote?80:0)+forward*5+Math.random()*25;
  if(n>score){score=n;best=m;}}
 let plan=[best];if(side===s.initialSecond&&!s.doubleUsed&&(s.round>10||s.board[best.to]?.t==='K')&&Math.random()<0.18){const copy=clone(s);apply(copy,side,best);const next=moves(copy,side);if(next.length)plan.push(next.sort((a,b)=>(values[copy.board[b.to]?.t]||0)-(values[copy.board[a.to]?.t]||0))[0]);}return plan;
}
