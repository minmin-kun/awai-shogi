import {initial,clone,LABELS,HAND,legal,reservable,projectReservation,apply,canPromote,forced,validatePlan,resolve,cpuPlan,pieceInfo} from '/engine.js';
import {draftEditContext,draftPieceSelection,replacementDestination} from '/planning.js';
const $=id=>document.getElementById(id);
const mobileGuide=matchMedia('(max-width:640px)');
$('guide-content').open=!mobileGuide.matches;
mobileGuide.addEventListener('change',()=>{$('guide-content').open=!mobileGuide.matches;});
const compactLayout=matchMedia('(max-width:930px)');
function syncCompactPanels(){
 const compact=compactLayout.matches;
 if(compact){document.querySelector('.right-panel').prepend($('connection-panel'));document.querySelector('.action-panel').append($('readiness'));}
 else{document.querySelector('.left-panel').insertBefore($('connection-panel'),document.querySelector('.order-panel'));document.querySelector('.turn-panel').append($('readiness'));}
}
compactLayout.addEventListener('change',syncCompactPanels);
syncCompactPanels();
let game=initial(),side=0,mode='cpu',started=false,draft=[],selection=null,doubleActive=false,locked=false,passing=false,resolving=false,deadline=null,cpu=null,cpuAt=null,room=null,offset=0,polling=false,submitting=false,startingClock=false,setupSide=0,pendingPromotion=null,confirmAction=null,lastErrorAt=0;
let inspectedPiece=null,connectionState='online',lastContact=Date.now();
let gameSession=0;
const name=s=>s===side?'あなた':mode==='cpu'?'練習相手':'相手';
const coord=i=>`${9-i%9}${'一二三四五六七八九'[Math.floor(i/9)]}`;
const toast=message=>{$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),3300);};
const open=id=>{if(!$(id).open)$(id).showModal();};
const canAct=()=>started&&!locked&&!resolving&&game.winner===null&&(!room||(room.joined&&deadline!==null));
const preview=()=>{const p=clone(game);for(const m of draft)projectReservation(p,side,m);return p;};
function draftDetails(){const p=clone(game);return draft.map(m=>{const detail={m,t:m.drop||p.board[m.from]?.t||'P',conditional:!legal(p,side,m)};projectReservation(p,side,m);return detail;});}
function pieceHTML(p){return `<span class="piece ${p.s!==side?'enemy ':''}${p.t.startsWith('+')?'promoted':''}"><span>${LABELS[p.t]}</span></span>`;}
function renderBoard(){
 const p=preview(),details=draftDetails(),edit=canAct()&&draft.length===(doubleActive?2:1)?draftEditContext(game,side,draft):null;
 const hintSelection=selection||edit?.selection,hintBoard=selection?p:edit?.board;
 const beforeStart=!started&&mode==='cpu';$('board-start').hidden=!beforeStart;$('board').setAttribute('aria-label',beforeStart?'将棋盤・対局前':'将棋盤');
 $('board').classList.toggle('resolving',resolving);$('board').innerHTML='';
 const indices=Array.from({length:81},(_,i)=>side===0?i:80-i);
 $('files').innerHTML=(side===0?'９８７６５４３２１':'１２３４５６７８９').split('').map(v=>`<span>${v}</span>`).join('');
 $('ranks').innerHTML=(side===0?'一二三四五六七八九':'九八七六五四三二一').split('').map(v=>`<span>${v}</span>`).join('');
 for(const i of indices){const cell=document.createElement('button');cell.className='square';cell.setAttribute('role','gridcell');cell.dataset.index=i;const v=game.board[i];cell.setAttribute('aria-label',`${coord(i)}${v?' '+name(v.s)+'の'+LABELS[v.t]:' 空きマス'}`);cell.innerHTML=v?pieceHTML(v):'';cell.disabled=resolving||!started;
  const reserved=details.map((d,n)=>({...d,n})).filter(d=>d.m.to===i);
  if(reserved.length){const last=reserved.at(-1),ghost=document.createElement('span');ghost.className='reservation-ghost'+(v?' occupied-ghost':'');ghost.setAttribute('aria-hidden','true');ghost.innerHTML=pieceHTML({s:side,t:(last.m.promote||forced({t:last.t,s:side},i))?'+'+last.t:last.t});cell.append(ghost);const badge=document.createElement('span');badge.className='reservation-badge';badge.textContent=reserved.map(d=>d.n+1).join('・')+'手目';cell.append(badge);cell.setAttribute('aria-label',cell.getAttribute('aria-label')+' '+reserved.map(d=>`${d.n+1}手目の移動予定の位置`).join(' '));}
  if(hintSelection?.from===i)cell.classList.add('selected');
  if(hintSelection&&canAct()&&(!edit||i!==draft.at(-1).to)&&reservable(hintBoard,side,{...hintSelection,to:i})){const conditional=!legal(hintBoard,side,{...hintSelection,to:i});cell.classList.add(conditional?'conditional':'legal');if(conditional)cell.setAttribute('aria-label',cell.getAttribute('aria-label')+' 条件付きの指し手');}
  if(game.last.some(e=>e.ok&&e.to===i))cell.classList.add('last-move');
  if(draft.some(m=>m.to===i))cell.classList.add('planned');cell.onclick=()=>pick(i);$('board').append(cell);
 }
 if(draft.length){const point=i=>{const j=side===0?i:80-i;return {x:j%9*100+50,y:Math.floor(j/9)*100+50};};const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('reservation-arrows');svg.setAttribute('viewBox','0 0 900 900');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');let content='<defs><marker id="reservation-arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z" fill="#416c50"/></marker></defs>';for(const [n,m]of draft.entries()){if(m.drop)continue;const a=point(m.from),b=point(m.to),length=Math.hypot(b.x-a.x,b.y-a.y),ux=(b.x-a.x)/length,uy=(b.y-a.y)/length;content+=`<line x1="${a.x+ux*20}" y1="${a.y+uy*20}" x2="${b.x-ux*28}" y2="${b.y-uy*28}" marker-end="url(#reservation-arrowhead)"/><text x="${(a.x+b.x)/2+12}" y="${(a.y+b.y)/2-10}">${n+1}</text>`;}svg.innerHTML=content;$('board').append(svg);}
 for(const [id,s]of [['my-hand',side],['their-hand',1-side]]){
  const el=$(id);el.innerHTML='';for(const t of HAND){const n=p.hands[s][t]||0;if(!n)continue;const b=document.createElement('button');b.className='hand-piece'+(selection?.drop===t&&s===side?' selected':'');b.innerHTML=pieceHTML({t,s})+`<b>${n}</b>`;b.setAttribute('aria-label',`${LABELS[t]} ${n}枚を打つ`);b.disabled=resolving;b.onclick=()=>{inspectedPiece={t,s};renderPieceHelp();if(s!==side||!canAct())return;if(draft.length===(doubleActive?2:1)){draft=draftEditContext(game,side,draft).draft;selection=null;passing=false;if(!(preview().hands[side][t]>0)){render();return;}}selection={drop:t};passing=false;render();};el.append(b);}if(!el.children.length)el.innerHTML='<span class="hand-empty">なし</span>';
 }
 updateNearConfirm();
}
function updateNearConfirm(){
 const button=$('near-confirm');
 button.hidden=!canAct()||passing||draft.length!==(doubleActive?2:1);
 if(button.hidden)return;
 button.textContent=doubleActive?'2手を確定':'確定 ✓';
 button.setAttribute('aria-label',doubleActive?'2手をまとめて確定':`${coord(draft.at(-1).to)}への指し手を確定`);
 positionNearConfirm();
}
function positionNearConfirm(){
 const button=$('near-confirm');if(button.hidden||!draft.length)return;
 const target=$('board').querySelector(`[data-index="${draft.at(-1).to}"]`);if(!target)return;
 const frame=button.parentElement,frameRect=frame.getBoundingClientRect(),cellRect=target.getBoundingClientRect();
 const originX=frameRect.left+frame.clientLeft,originY=frameRect.top+frame.clientTop;
 const width=button.offsetWidth,height=button.offsetHeight;
 let x=cellRect.right-originX-12,y=cellRect.top-originY-height+8;
 const below=y<4;if(below)y=cellRect.bottom-originY-8;
 x=Math.max(4,Math.min(x,frame.clientWidth-width-4));y=Math.max(4,Math.min(y,frame.clientHeight-height-4));
 button.style.left=`${x}px`;button.style.top=`${y}px`;button.dataset.placement=below?'below':'above';
}
const confirmPlacementObserver=new ResizeObserver(positionNearConfirm);
confirmPlacementObserver.observe($('board'));confirmPlacementObserver.observe($('near-confirm'));
function render(){
 renderBoard();const ownFirst=game.leader===side,opponent=mode==='cpu'?'練習相手':'相手';
 $('round').textContent=`第 ${game.round} ターン`;$('opponent-name').textContent=opponent;$('top-name').textContent=opponent;$('top-sub').textContent=mode==='cpu'?'CPU':'PLAYER';
 $('my-start').textContent=`最初は${side===0?'先手':'後手'}`;$('their-start').textContent=`最初は${side===0?'後手':'先手'}`;$('bottom-sub').textContent=`最初は${side===0?'先手':'後手'}`;
 $('my-order').textContent=ownFirst?'先手':'後手';$('my-order').classList.toggle('first',ownFirst);$('their-order').textContent=ownFirst?'後手':'先手';$('their-order').classList.toggle('first',!ownFirst);
 $('top-order').textContent=ownFirst?'後手 · 2番目に移動':'先手 · 1番目に移動';$('bottom-order').textContent=ownFirst?'先手 · 1番目に移動':'後手 · 2番目に移動';
 $('top-order').classList.toggle('first',!ownFirst);$('bottom-order').classList.toggle('first',ownFirst);
 const ended=game.winner!==null;
 const waitingClock=room?.joined&&deadline===null&&!ended&&!resolving;
 $('phase-title').textContent=ended?'対局終了':resolving?'移動中':!started?'対局準備':room&&!room.joined?'相手を待っています':waitingClock?'思考時間を準備中':'思考中';
 $('phase-description').textContent=ended?`${name(game.winner)}の勝ちです。`:resolving?'決めた一手を、順番に実行します。':!started?'準備ができたら、はじめましょう。':room&&!room.joined?'ルームコードを相手に伝えてください。':waitingClock?'盤面の準備ができたら30秒を開始します。':locked?'相手の確定を待っています。':'相手の一手を読み、駒を選びましょう。';
 if(started&&!ended&&!document.body.classList.contains('in-game')&&mobileGuide.matches)$('guide-content').open=false;
 document.body.classList.toggle('in-game',started&&!ended);
 $('think-step').classList.toggle('current',!resolving);$('move-step').classList.toggle('current',resolving);
 const readyOther=room?room.ready[1-side]:cpu!==null;
 $('my-ready').classList.toggle('ready',locked);$('their-ready').classList.toggle('ready',readyOther);$('my-ready-text').textContent=locked?'確定済み':draft.length?'選択中':'未選択';$('their-ready-text').textContent=readyOther?'確定済み':started?'思考中':'待機中';
 const details=draftDetails();
 const list=$('plan-list');if(draft.length)list.innerHTML=details.map(({m,t,conditional},i)=>`<div class="plan-move"><small>0${i+1}</small><b>${LABELS[t]}</b><span>${coord(m.to)}${m.drop?' 打':m.promote?' 成':''}</span>${conditional?'<small class="conditional-label">条件付き</small>':''}</div>`).join('');else list.innerHTML=`<div class="empty-plan"><span>${passing?'休':locked?'✓':'一'}</span><p>${!started?'対局開始前です。':passing?'このターンを、見送る。':locked?'一手を、確定しました。':'一手を、選びましょう。'}</p><small>${!started?'対局を始めると指し手を選べます':passing?'パスを確定してください':locked?'相手の選択を待っています':'駒 → 移動先 の順にタップ'}</small></div>`;
 $('confirm').hidden=!started;
 $('confirm').innerHTML=ended?'対局は終了しました':resolving?'駒を移動しています':room&&!room.joined?'ルームコードを表示 <span>↗</span>':locked?'相手の選択を待っています':passing?'パスを確定する <span>→</span>':doubleActive?`二度打ちを確定 (${draft.length}/2) <span>→</span>`:'この一手を確定 <span>→</span>';
 $('double').setAttribute('aria-pressed',String(doubleActive));
 $('confirm').disabled=!started||ended||resolving||locked||waitingClock||(started&&(!room||room.joined)&&!passing&&draft.length!==(doubleActive?2:1));
 $('undo').disabled=!canAct()||(!draft.length&&!selection&&!passing);$('pass').disabled=!canAct();$('resign').disabled=!canAct()&&!locked||!started||ended||resolving||room&&!room.joined;
 $('undo').textContent=draft.length===2?'↶ 2手目を取り消す':draft.length===1?'↶ 1手目を取り消す':'↶ 選び直す';
 $('clear-plan').hidden=draft.length<2;$('clear-plan').disabled=!canAct();
 const hasDouble=side===game.initialSecond;
 $('double').disabled=!canAct()||!hasDouble||game.doubleUsed;$('double').classList.toggle('enabled',hasDouble&&!game.doubleUsed);$('double').classList.toggle('activated',doubleActive);
 $('double-help').textContent=!hasDouble?'最初に後手だった人だけが使えます':game.doubleUsed?'この対局では使用済み':doubleActive?(draft.length===2?'2手が揃いました':'2手目を選んでください'):'タップして2手を選ぶ';$('double-status').textContent=!hasDouble?'対象外':game.doubleUsed?'使用済み':doubleActive?'選択中':'残り1回';
 $('cpu-mode').classList.toggle('active',mode==='cpu');$('online-mode').classList.toggle('active',mode==='online');
 $('board-status').textContent=room&&!room.joined?`ルーム ${room.code} · 相手の参加を待っています` :ended?`${name(game.winner)}の勝利。おつかれさまでした。`:resolving?'指し手を実行しています。':locked?'選択を確定しました。半透明の駒と矢印は移動予定です。':selection?'緑の丸は現在移動可能、点線のマスは条件付きで指定できます。':doubleActive&&draft.length===1?'2手目は半透明の移動予定の駒、または別の駒を選んでください。':draft.length?details.some(d=>d.conditional)?'移動先の近くの「確定」で送信。実行時に動けなければ元の位置に留まります。':'「確定」で送信。別の駒や移動可能なマスをタップすると指し手を選び直せます。':doubleActive?`二度打ち：${draft.length}/2 手を指定。同じ駒をもう一度動かすこともできます。`:'◇ 駒と移動先を選ぶと、移動先の近くに「確定」が表示されます。';
 renderHistory();renderClock();renderPieceHelp();renderConnection();
}
function movementDiagram(info,owner){
 const direction=owner===side?1:-1,targets=new Map();
 for(const [x,y]of info.steps)targets.set(`${x*direction},${y*direction}`,'●');
 for(const [x,y]of info.rays)for(let n=1;n<=2;n++){const dx=x*direction,dy=y*direction;const arrows={'-1,-1':'↖','0,-1':'↑','1,-1':'↗','-1,0':'←','1,0':'→','-1,1':'↙','0,1':'↓','1,1':'↘'};targets.set(`${dx*n},${dy*n}`,n===2?arrows[`${dx},${dy}`]:'●');}
 let html=`<div class="movement-diagram" role="img" aria-label="${info.name}の動き：${info.description}">`;
 for(let y=-2;y<=2;y++)for(let x=-2;x<=2;x++){const mark=targets.get(`${x},${y}`);html+=`<span class="${x===0&&y===0?'diagram-piece':mark?'diagram-target':''}">${x===0&&y===0?info.label:mark||''}</span>`;}return html+'</div>';
}
function renderPieceHelp(){
 const el=$('piece-help');if(!inspectedPiece){el.innerHTML='<div class="piece-help-placeholder"><span>駒の動きを確認</span><p>盤上の駒や持ち駒をタップすると、動き方と成った後の変化を表示します。</p></div>';return;}
 const info=pieceInfo(inspectedPiece.t);if(!info)return;
 const promoted=info.promotion?pieceInfo(info.promotion):null,own=inspectedPiece.s===side;
 el.innerHTML=`<div class="piece-help-heading"><strong>${info.name} <span>${info.label}</span></strong><small>${own?'あなたの駒 · 上が前方':'相手の駒 · 下が前方'}</small></div><div class="piece-help-content"><figure>${movementDiagram(info,inspectedPiece.s)}<figcaption>現在の動き</figcaption></figure><div class="piece-help-copy"><p>${info.description}</p>${promoted?`<strong>成ると：${promoted.name}（${promoted.label}）</strong><p>${promoted.description}</p>`:`<p class="piece-promotion-note">${info.type.startsWith('+')?'この駒は成り済みです。これ以上は成りません。':'この駒は成りません。'}</p>`}</div>${promoted?`<figure>${movementDiagram(promoted,inspectedPiece.s)}<figcaption>成った後の動き</figcaption></figure>`:''}</div><div class="piece-help-legend">●：移動先　矢印：その方向に何マスでも${info.promotion?'　移動前か移動先が敵陣3段なら成れます':''}</div>`;
}
function renderConnection(){
 const panel=$('connection-panel');panel.hidden=mode!=='online'||!room;if(panel.hidden)return;
 const ended=game.winner!==null,self=ended?'ended':navigator.onLine===false?'offline':Date.now()-lastContact>12000?'reconnecting':connectionState;
 const peer=self==='online'?(room.presence?.[1-side]||'unknown'):'unknown';
 const set=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
 $('self-connection').dataset.state=self;$('peer-connection').dataset.state=peer;
 set('self-connection',ended?'あなた：対局終了':self==='online'?'あなた：接続中':self==='offline'?'あなた：オフライン':'あなた：再接続中');
 set('peer-connection',ended?'相手：対局終了':!room.joined?'相手：参加待ち':peer==='online'?'相手：接続中':peer==='disconnected'?'相手：応答なし':'相手：接続確認中');
 set('connection-note',ended?'対局は終了しました。':self!=='online'?'サーバーとの通信を再試行しています。接続が戻ると盤面を同期します。':!room.joined?'ルームコードを相手に伝えてください。':peer==='disconnected'?'相手から12秒以上応答がありません。切断や画面の非表示の可能性があります。思考時間は通常どおり進みます。':peer==='unknown'?'相手の通信状態を確認しています。':'通信状態と指し手の確定状況は、それぞれ別に表示しています。');
 if(room.joined&&!ended){if(self!=='online')set('their-ready-text','通信確認中');else if(peer==='disconnected')set('their-ready-text','応答なし');else if(peer==='unknown')set('their-ready-text','接続確認中');else set('their-ready-text',room.ready[1-side]?'確定済み':'思考中');}
}
function renderHistory(){
 $('history-count').textContent=`${game.history.reduce((n,h)=>n+h.events.filter(e=>e.to!==undefined).length,0)} 手`;
 if(!game.history.length){$('history').innerHTML='<div class="history-empty"><span>⌁</span><p>ここから、棋譜がはじまります。</p></div>';return;}
 $('history').innerHTML=game.history.slice().reverse().map(h=>`<div class="history-round"><h3>第 ${h.round} ターン${h.swap?'<span>⇄ 順序交代</span>':''}</h3>${h.events.map(e=>`<div class="history-event"><i class="side-dot ${e.side===side?'self':''}"></i><span>${e.text}${e.reason?`<span class="history-reason">${e.reason}</span>`:''}</span><small>${name(e.side)}</small></div>`).join('')}</div>`).join('');
}
function renderClock(){const remaining=!started||!deadline?30:game.winner!==null||resolving?0:Math.max(0,Math.ceil((deadline-Date.now()-offset)/1000));$('seconds').textContent=String(remaining).padStart(2,'0');$('timer-bar').style.width=`${remaining/30*100}%`;$('timer-bar').classList.toggle('urgent',remaining<=8);}
function pick(i){
 const inspect=()=>{const piece=preview().board[i]||game.board[i];if(piece){inspectedPiece={t:piece.t,s:piece.s};renderPieceHelp();}};
 if(!canAct()){inspect();return;}
 if(draft.length===(doubleActive?2:1)){
  const chosen=draftPieceSelection(game,side,draft,i);
  if(chosen){draft=chosen.draft;selection=chosen.selection;passing=false;pendingPromotion=null;inspectedPiece={t:chosen.piece.t,s:side};render();return;}
  const replacement=replacementDestination(game,side,draft,i);
  if(replacement){draft=replacement.draft;selection=replacement.selection;passing=false;pendingPromotion=null;reserveDestination(replacement.board,selection,i);return;}
  inspect();return;
 }
 const p=preview();if(selection&&reservable(p,side,{...selection,to:i})){
  reserveDestination(p,selection,i);return;
 }
 inspect();if(p.board[i]?.s===side){selection={from:i,id:p.board[i].id};passing=false;render();}else{selection=null;render();}
}
function reserveDestination(state,chosen,to){
 const move={...chosen,to},piece=chosen.drop?null:state.board[chosen.from];
 if(piece&&canPromote(piece,move.from,to)&&!forced(piece,to)){pendingPromotion=move;render();open('promote-dialog');return;}
 addMove(move);
}
function addMove(m){draft.push(m);selection=null;passing=false;render();}
$('promote-yes').onclick=()=>{const m=pendingPromotion;pendingPromotion=null;$('promote-dialog').close();if(canAct()&&m)addMove({...m,promote:true});};$('promote-no').onclick=()=>{const m=pendingPromotion;pendingPromotion=null;$('promote-dialog').close();if(canAct()&&m)addMove(m);};
$('undo').onclick=()=>{if(draft.length)draft.pop();selection=null;passing=false;render();};
$('clear-plan').onclick=()=>{draft=[];selection=null;passing=false;render();};
$('pass').onclick=()=>{if(!canAct())return;draft=[];selection=null;doubleActive=false;passing=true;render();};
$('double').onclick=()=>{if(!canAct()||side!==game.initialSecond||game.doubleUsed)return;doubleActive=!doubleActive;if(!doubleActive)draft=draft.slice(0,1);passing=false;selection=null;render();};
function startCPU(){
 gameSession++;
 room=null;inspectedPiece=null;sessionStorage.removeItem('awai-room');mode='cpu';side=setupSide;game=initial();started=true;draft=[];selection=null;doubleActive=false;locked=false;passing=false;resolving=false;offset=0;beginCPU();render();
}
function beginCPU(){deadline=Date.now()+30000;cpu=null;cpuAt=Date.now()+1800+Math.random()*2200;}
async function animate(next){
 const session=gameSession;
 resolving=true;selection=null;draft=[];locked=false;pendingPromotion=null;$('promote-dialog').close();doubleActive=false;passing=false;render();
 const events=next.last;
 for(const event of events){if(event.to===undefined)continue;await new Promise(r=>setTimeout(r,380));if(session!==gameSession)return;if(event.ok)apply(game,event.side,event);game.last=[event];$('board-status').textContent=`${name(event.side)}：${event.text}${event.reason?'（'+event.reason+'）':''}`;renderBoard();}
 await new Promise(r=>setTimeout(r,350));if(session!==gameSession)return;game=next;resolving=false;
 if(mode==='cpu'&&game.winner===null)beginCPU();render();
 if(mode==='online')void ensureClock();
 if(game.winner!==null)showResult();else if(next.history.at(-1)?.swap)toast('駒を取ったため、先手・後手が交代しました。');
}
function resolveCPU(){if(resolving||!started||cpu===null||!locked)return;const plans=[];plans[side]=draft;plans[1-side]=cpu;const next=resolve(game,plans);cpuAt=null;void animate(next);}
async function commit(){
 if(!started)return;if(room&&!room.joined){open('room-dialog');return;}if(!canAct())return;
 try{const plan=validatePlan(game,side,passing?[]:draft);if(!passing&&plan.length!==(doubleActive?2:1))return;draft=plan;
  if(mode==='cpu'){locked=true;selection=null;render();resolveCPU();}
  else{submitting=true;locked=true;selection=null;render();const data=await request(`/api/rooms/${room.code}/plan`,{round:game.round,plan});await accept(data);}
 }catch(e){locked=false;toast(e.message);render();}finally{submitting=false;}
}
$('confirm').onclick=commit;
$('near-confirm').onclick=e=>{e.preventDefault();e.stopPropagation();void commit();};
function showResult(){for(const id of ['room-dialog','promote-dialog'])$(id).close();$('result-title').textContent=game.winner===side?'あなたの勝ちです。':'相手の勝ちです。';$('result-note').textContent=game.resigned!==undefined?`${name(game.resigned)}が投了しました。`:`${name(game.winner)}が王を取りました。`+` ${game.round-1}ターンの対局でした。`;open('end-dialog');}
function setup(nextMode){$('cpu-settings').hidden=nextMode!=='cpu';$('online-settings').hidden=nextMode!=='online';$('room-error').textContent='';setupSide=side;document.querySelectorAll('[data-side]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.side)===setupSide));open('setup-dialog');}
function ask(title,description,action){$('confirm-title').textContent=title;$('confirm-description').textContent=description;confirmAction=action;open('confirm-dialog');}
function newSetup(nextMode){if(started&&game.winner===null)ask('対局を終了しますか？','オンライン対局中は投了してから、新しい対局へ進みます。',async()=>{if(room?.joined)await request(`/api/rooms/${room.code}/resign`,{});gameSession++;resolving=false;started=false;room=null;mode=nextMode;game=initial();draft=[];selection=null;doubleActive=false;locked=false;passing=false;deadline=null;cpu=null;cpuAt=null;sessionStorage.removeItem('awai-room');render();setup(nextMode);});else setup(nextMode);}
$('confirm-yes').onclick=async()=>{const action=confirmAction;confirmAction=null;$('confirm-dialog').close();try{await action?.();}catch(e){toast(e.message);}};$('confirm-no').onclick=()=>{confirmAction=null;$('confirm-dialog').close();};
$('cpu-mode').onclick=()=>newSetup('cpu');$('online-mode').onclick=()=>{if(room&&!room.joined){open('room-dialog');return;}newSetup('online');};$('new-game').onclick=()=>newSetup(mode);
document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{setupSide=Number(b.dataset.side);document.querySelectorAll('[data-side]').forEach(x=>x.classList.toggle('selected',x===b));});
$('start-cpu').onclick=()=>{$('setup-dialog').close();startCPU();};$('board-start-button').onclick=()=>setup('cpu');$('guide-details').onclick=()=>open('rules-dialog');
document.querySelectorAll('.dialog-close,.dialog-dismiss').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('play-again').onclick=()=>{$('end-dialog').close();setup(mode);};
$('resign').onclick=()=>ask('この一局を、投了しますか？','投了すると相手の勝利で対局が終了します。',async()=>{if(room){const next=await request(`/api/rooms/${room.code}/resign`,{});await accept(next);}else{game.winner=1-side;game.resigned=side;render();showResult();}});
async function request(path,body,auth=room?.token){
 const watching=!!room&&path.startsWith(`/api/rooms/${room.code}`);let reached=false;
 try{const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(auth?{'Authorization':'Bearer '+auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const data=await res.json();reached=true;
  if(watching){const recovered=connectionState!=='online';connectionState='online';lastContact=Date.now();renderConnection();if(recovered)toast('接続が復旧しました。盤面を同期します。');}
  if(!res.ok)throw new Error(data.error||'接続できませんでした。');return data;
 }catch(e){if(watching&&!reached){connectionState=navigator.onLine===false?'offline':'reconnecting';renderConnection();}throw e;}
}
function saveRoom(){sessionStorage.setItem('awai-room',JSON.stringify({code:room.code,token:room.token}));}
async function enter(data){
 gameSession++;
 connectionState='online';lastContact=Date.now();inspectedPiece=null;
 room={...data};mode='online';started=true;side=data.side;game=data.game;draft=data.ownPlan||[];selection=null;doubleActive=draft.length===2;locked=data.ready[side];passing=false;resolving=false;cpu=null;cpuAt=null;offset=data.serverTime-Date.now();deadline=data.deadline;saveRoom();$('setup-dialog').close();$('share-code').textContent=data.code;render();if(!data.joined)open('room-dialog');else void ensureClock();
}
async function ensureClock(){
 if(!room?.joined||deadline!==null||startingClock||resolving||game.winner!==null)return;
 startingClock=true;const code=room.code,round=game.round;
 try{const data=await request(`/api/rooms/${code}/ready`,{round});if(room?.code===code)await accept(data);}catch(e){toast('思考時間の開始を再試行しています。');}finally{startingClock=false;}
}
async function accept(data){
 if(!room||data.version<(room.version||0)||data.game.round<game.round)return;const old=game,token=room.token,reconnected=room.presence?.[1-side]==='disconnected'&&data.presence?.[1-side]==='online';room={...data,token};offset=data.serverTime-Date.now();deadline=data.deadline;if(reconnected)toast('相手が再接続しました。');
 if(data.joined)$('room-dialog').close();
 if(data.game.round>old.round){draft=[];locked=false;doubleActive=false;passing=false;if(data.game.round===old.round+1)await animate(data.game);else{game=data.game;render();if(game.winner!==null)showResult();}}
 else{const justEnded=old.winner===null&&data.game.winner!==null;game=data.game;locked=data.ready[side];if(locked)draft=data.ownPlan||[];render();if(justEnded)showResult();}
 if(!resolving)void ensureClock();
}
let roomBusy=false;
async function createOrJoin(join){if(roomBusy)return;roomBusy=true;$('create-room').disabled=true;$('join-room').disabled=true;$('room-error').textContent='';try{const code=$('room-code').value.replace(/\s/g,'').toUpperCase();if(join&&!/^[A-F0-9]{8}$/.test(code))throw new Error('8桁のルームコードを入力してください。');const data=await request(join?`/api/rooms/${code}/join`:'/api/rooms',join?{}:{side:Number($('room-role').value)},null);await enter(data);}catch(e){$('room-error').textContent=e.message;}finally{roomBusy=false;$('create-room').disabled=false;$('join-room').disabled=false;}}
$('create-room').onclick=()=>createOrJoin(false);$('join-room').onclick=()=>createOrJoin(true);$('room-code').onkeydown=e=>{if(e.key==='Enter')void createOrJoin(true);};
$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(room.code);toast('ルームコードをコピーしました。');}catch{toast('コードを選択してコピーしてください：'+room.code);}};
setInterval(()=>{renderClock();renderConnection();if(!started||resolving||game.winner!==null||room)return;if(cpu===null&&Date.now()>=cpuAt){cpu=validatePlan(game,1-side,cpuPlan(game,1-side));render();resolveCPU();}if(Date.now()>=deadline){if(!locked){draft=[];locked=true;selection=null;pendingPromotion=null;$('promote-dialog').close();toast('時間切れのため、パスになりました。');}if(cpu===null)cpu=[];resolveCPU();}},200);
async function pollRoom(){if(!room||polling||submitting||resolving||game.winner!==null)return;polling=true;const code=room.code;try{const data=await request(`/api/rooms/${code}`);if(!submitting&&room?.code===code)await accept(data);}catch(e){if(Date.now()-lastErrorAt>15000){toast('接続を再試行しています：'+e.message);lastErrorAt=Date.now();}}finally{polling=false;}}
setInterval(pollRoom,1000);
window.addEventListener('offline',()=>{connectionState='offline';renderConnection();});
window.addEventListener('online',()=>{connectionState='reconnecting';renderConnection();void pollRoom();});
render();
try{const saved=JSON.parse(sessionStorage.getItem('awai-room')||'null');if(saved?.code&&saved?.token){room=saved;const data=await request(`/api/rooms/${saved.code}`);await enter({...data,token:saved.token});if(game.winner!==null)showResult();}}catch{room=null;sessionStorage.removeItem('awai-room');toast('前のルームに接続できませんでした。新しい対局を作れます。');}
