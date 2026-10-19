import {initial,clone,LABELS,HAND,legal,reservable,projectReservation,apply,canPromote,forced,validatePlan,resolve,cpuPlan} from '/engine.js';
const $=id=>document.getElementById(id);
let game=initial(),side=0,mode='cpu',started=false,draft=[],selection=null,doubleActive=false,locked=false,passing=false,resolving=false,deadline=null,cpu=null,cpuAt=null,room=null,offset=0,polling=false,submitting=false,setupSide=0,pendingPromotion=null,confirmAction=null,lastErrorAt=0;
const name=s=>s===side?'あなた':mode==='cpu'?'練習相手':'相手';
const coord=i=>`${9-i%9}${'一二三四五六七八九'[Math.floor(i/9)]}`;
const toast=message=>{$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),3300);};
const open=id=>{if(!$(id).open)$(id).showModal();};
const canAct=()=>started&&!locked&&!resolving&&game.winner===null&&(!room||room.joined);
const preview=()=>{const p=clone(game);if(!locked)for(const m of draft)projectReservation(p,side,m);return p;};
function draftDetails(){const p=clone(game);return draft.map(m=>{const detail={m,t:m.drop||p.board[m.from]?.t||'P',conditional:!legal(p,side,m)};projectReservation(p,side,m);return detail;});}
function pieceHTML(p){return `<span class="piece ${p.s!==side?'enemy ':''}${p.t.startsWith('+')?'promoted':''}"><span>${LABELS[p.t]}</span></span>`;}
function renderBoard(){
 const p=preview();$('board').classList.toggle('resolving',resolving);$('board').innerHTML='';
 const indices=Array.from({length:81},(_,i)=>side===0?i:80-i);
 $('files').innerHTML=(side===0?'９８７６５４３２１':'１２３４５６７８９').split('').map(v=>`<span>${v}</span>`).join('');
 $('ranks').innerHTML=(side===0?'一二三四五六七八九':'九八七六五四三二一').split('').map(v=>`<span>${v}</span>`).join('');
 for(const i of indices){const cell=document.createElement('button');cell.className='square';cell.setAttribute('role','gridcell');cell.dataset.index=i;const v=p.board[i];cell.setAttribute('aria-label',`${coord(i)}${v?' '+name(v.s)+'の'+LABELS[v.t]:' 空きマス'}`);cell.innerHTML=v?pieceHTML(v):'';cell.disabled=!canAct();
  if(selection?.from===i)cell.classList.add('selected');
  if(selection&&canAct()&&reservable(p,side,{...selection,to:i})){const conditional=!legal(p,side,{...selection,to:i});cell.classList.add(conditional?'conditional':'legal');if(conditional)cell.setAttribute('aria-label',cell.getAttribute('aria-label')+' 条件付き予約');}
  if(game.last.some(e=>e.ok&&e.to===i))cell.classList.add('last-move');
  if(draft.some(m=>m.to===i))cell.classList.add('planned');cell.onclick=()=>pick(i);$('board').append(cell);
 }
 for(const [id,s]of [['my-hand',side],['their-hand',1-side]]){
  const el=$(id);el.innerHTML='';for(const t of HAND){const n=p.hands[s][t]||0;if(!n)continue;const b=document.createElement('button');b.className='hand-piece'+(selection?.drop===t&&s===side?' selected':'');b.innerHTML=pieceHTML({t,s})+`<b>${n}</b>`;b.setAttribute('aria-label',`${LABELS[t]} ${n}枚を打つ`);b.disabled=s!==side||!canAct();b.onclick=()=>{if(draft.length>=(doubleActive?2:1))return toast('選び直してから駒を選んでください。');selection={drop:t};passing=false;render();};el.append(b);}if(!el.children.length)el.innerHTML='<span class="hand-empty">なし</span>';
 }
}
function render(){
 renderBoard();const ownFirst=game.leader===side,opponent=mode==='cpu'?'練習相手':'相手';
 $('round').textContent=`第 ${game.round} ターン`;$('opponent-name').textContent=opponent;$('top-name').textContent=opponent;$('top-sub').textContent=mode==='cpu'?'CPU':'PLAYER';
 $('my-start').textContent=`開始時：${side===0?'先手':'後手'}`;$('their-start').textContent=`開始時：${side===0?'後手':'先手'}`;$('bottom-sub').textContent=`開始${side===0?'先手':'後手'}`;
 $('my-order').textContent=ownFirst?'先手':'後手';$('my-order').classList.toggle('first',ownFirst);$('their-order').textContent=ownFirst?'後手':'先手';$('their-order').classList.toggle('first',!ownFirst);
 $('top-order').textContent=ownFirst?'後手 · 2番目に移動':'先手 · 1番目に移動';$('bottom-order').textContent=ownFirst?'先手 · 1番目に移動':'後手 · 2番目に移動';
 const ended=game.winner!==null;
 $('phase-title').textContent=ended?'対局終了':resolving?'移動フェイズ':!started?'対局準備':room&&!room.joined?'相手を待っています':'思考フェイズ';
 $('phase-description').textContent=ended?`${name(game.winner)}の勝ちです。`:resolving?'予約した一手を、順番に実行します。':!started?'準備ができたら、はじめましょう。':room&&!room.joined?'ルームコードを相手に伝えてください。':locked?'相手の確定を待っています。':'相手の一手を読み、駒を選びましょう。';
 $('think-step').classList.toggle('current',!resolving);$('move-step').classList.toggle('current',resolving);
 const readyOther=room?room.ready[1-side]:cpu!==null;
 $('my-ready').classList.toggle('ready',locked);$('their-ready').classList.toggle('ready',readyOther);$('my-ready-text').textContent=locked?'確定済み':draft.length?'選択中':'未選択';$('their-ready-text').textContent=readyOther?'確定済み':started?'思考中':'待機中';
 const details=draftDetails();
 const list=$('plan-list');if(draft.length)list.innerHTML=details.map(({m,t,conditional},i)=>`<div class="plan-move"><small>0${i+1}</small><b>${LABELS[t]}</b><span>${coord(m.to)}${m.drop?' 打':m.promote?' 成':''}</span>${conditional?'<small class="conditional-label">条件付き</small>':''}</div>`).join('');else list.innerHTML=`<div class="empty-plan"><span>${passing?'休':locked?'✓':'一'}</span><p>${passing?'このターンを、見送る。':locked?'一手を、確定しました。':'一手を、選びましょう。'}</p><small>${passing?'パスを確定してください':locked?'相手の選択を待っています':'駒 → 移動先 の順にタップ'}</small></div>`;
 $('confirm').innerHTML=!started?'対局をはじめる <span>→</span>':ended?'対局は終了しました':resolving?'駒を移動しています':room&&!room.joined?'ルームコードを表示 <span>↗</span>':locked?'相手の選択を待っています':passing?'パスを確定する <span>→</span>':doubleActive?`二度打ちを確定 (${draft.length}/2) <span>→</span>`:'この一手を確定 <span>→</span>';
 $('confirm').disabled=ended||resolving||locked||(started&&(!room||room.joined)&&!passing&&draft.length!==(doubleActive?2:1));
 $('undo').disabled=!canAct()||(!draft.length&&!selection&&!passing);$('pass').disabled=!canAct();$('resign').disabled=!canAct()&&!locked||!started||ended||resolving||room&&!room.joined;
 const hasDouble=side===game.initialSecond;
 $('double').disabled=!canAct()||!hasDouble||game.doubleUsed;$('double').classList.toggle('enabled',hasDouble&&!game.doubleUsed);$('double').classList.toggle('activated',doubleActive);
 $('double-help').textContent=!hasDouble?'開始後手だけが使えます':game.doubleUsed?'この対局では使用済み':doubleActive?'2手目を予約してください':'タップして2手を予約';$('double-status').textContent=!hasDouble?'対象外':game.doubleUsed?'使用済み':doubleActive?'選択中':'残り1回';
 $('cpu-mode').classList.toggle('active',mode==='cpu');$('online-mode').classList.toggle('active',mode==='online');
 $('board-status').textContent=room&&!room.joined?`ルーム ${room.code} · 相手の参加を待っています` :ended?`${name(game.winner)}の勝利。おつかれさまでした。`:resolving?'予約手を実行しています。':details.some(d=>d.conditional)?'条件付き予約：実行時に動けなければ、元の位置に留まります。':locked?'選択を確定しました。相手にはまだ見えません。':selection?'緑の丸は現在移動可能、点線のマスは条件付きで予約できます。':doubleActive?`二度打ち：${draft.length}/2 手を予約。同じ駒をもう一度動かすこともできます。`:'◇ 駒を選ぶと、移動可能なマスと条件付きの予約先が表示されます。';
 renderHistory();renderClock();
}
function renderHistory(){
 $('history-count').textContent=`${game.history.reduce((n,h)=>n+h.events.filter(e=>e.to!==undefined).length,0)} 手`;
 if(!game.history.length){$('history').innerHTML='<div class="history-empty"><span>⌁</span><p>ここから、棋譜がはじまります。</p></div>';return;}
 $('history').innerHTML=game.history.slice().reverse().map(h=>`<div class="history-round"><h3>第 ${h.round} ターン${h.swap?'<span>⇄ 順序交代</span>':''}</h3>${h.events.map(e=>`<div class="history-event"><i class="side-dot ${e.side===side?'self':''}"></i>${e.text}<small>${name(e.side)}</small></div>`).join('')}</div>`).join('');
}
function renderClock(){const remaining=!started||!deadline?30:game.winner!==null||resolving?0:Math.max(0,Math.ceil((deadline-Date.now()-offset)/1000));$('seconds').textContent=String(remaining).padStart(2,'0');$('timer-bar').style.width=`${remaining/30*100}%`;$('timer-bar').classList.toggle('urgent',remaining<=8);}
function pick(i){
 if(!canAct())return;if(draft.length>=(doubleActive?2:1)){toast(doubleActive?'2手を予約しました。確定するか、選び直してください。':'一手を予約しました。確定するか、二度打ちを選んでください。');return;}
 const p=preview();if(selection&&reservable(p,side,{...selection,to:i})){
  const m={...selection,to:i};const piece=selection.drop?null:p.board[selection.from];
  if(piece&&canPromote(piece,m.from,i)&&!forced(piece,i)){pendingPromotion=m;open('promote-dialog');return;}addMove(m);return;
 }
 if(p.board[i]?.s===side){selection={from:i,id:p.board[i].id};passing=false;render();}else{selection=null;renderBoard();}
}
function addMove(m){draft.push(m);selection=null;passing=false;render();}
$('promote-yes').onclick=()=>{const m=pendingPromotion;pendingPromotion=null;$('promote-dialog').close();if(canAct()&&m)addMove({...m,promote:true});};$('promote-no').onclick=()=>{const m=pendingPromotion;pendingPromotion=null;$('promote-dialog').close();if(canAct()&&m)addMove(m);};
$('undo').onclick=()=>{draft=[];selection=null;passing=false;render();};
$('pass').onclick=()=>{draft=[];selection=null;doubleActive=false;passing=true;render();};
$('double').onclick=()=>{if(!canAct()||side!==game.initialSecond||game.doubleUsed)return;doubleActive=!doubleActive;if(!doubleActive)draft=draft.slice(0,1);passing=false;selection=null;render();};
function startCPU(){
 room=null;sessionStorage.removeItem('awai-room');mode='cpu';side=setupSide;game=initial();started=true;draft=[];selection=null;doubleActive=false;locked=false;passing=false;resolving=false;offset=0;beginCPU();render();
}
function beginCPU(){deadline=Date.now()+30000;cpu=null;cpuAt=Date.now()+1800+Math.random()*2200;}
async function animate(next){
 resolving=true;selection=null;draft=[];locked=false;pendingPromotion=null;$('promote-dialog').close();doubleActive=false;passing=false;render();
 const events=next.last;
 for(const event of events){if(event.to===undefined)continue;await new Promise(r=>setTimeout(r,380));if(event.ok)apply(game,event.side,event);game.last=[event];$('board-status').textContent=`${name(event.side)}：${event.text}`;renderBoard();}
 await new Promise(r=>setTimeout(r,350));game=next;resolving=false;
 if(mode==='cpu'&&game.winner===null)beginCPU();render();
 if(game.winner!==null)showResult();else if(next.history.at(-1)?.swap)toast('駒を取ったため、先手・後手が交代しました。');
}
function resolveCPU(){if(resolving||!started||cpu===null||!locked)return;const plans=[];plans[side]=draft;plans[1-side]=cpu;const next=resolve(game,plans);cpuAt=null;void animate(next);}
async function commit(){
 if(!started){setup('cpu');return;}if(room&&!room.joined){open('room-dialog');return;}if(!canAct())return;
 try{const plan=validatePlan(game,side,passing?[]:draft);if(!passing&&plan.length!==(doubleActive?2:1))return;draft=plan;
  if(mode==='cpu'){locked=true;selection=null;render();resolveCPU();}
  else{submitting=true;locked=true;selection=null;render();const data=await request(`/api/rooms/${room.code}/plan`,{round:game.round,plan});await accept(data);}
 }catch(e){locked=false;toast(e.message);render();}finally{submitting=false;}
}
$('confirm').onclick=commit;
function showResult(){for(const id of ['room-dialog','promote-dialog'])$(id).close();$('result-title').textContent=game.winner===side?'あなたの勝ちです。':'相手の勝ちです。';$('result-note').textContent=game.resigned!==undefined?`${name(game.resigned)}が投了しました。`:`${name(game.winner)}が王を取りました。`+` ${game.round-1}ターンの対局でした。`;open('end-dialog');}
function setup(nextMode){$('cpu-settings').hidden=nextMode!=='cpu';$('online-settings').hidden=nextMode!=='online';$('room-error').textContent='';setupSide=side;document.querySelectorAll('[data-side]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.side)===setupSide));open('setup-dialog');}
function ask(title,description,action){$('confirm-title').textContent=title;$('confirm-description').textContent=description;confirmAction=action;open('confirm-dialog');}
function newSetup(nextMode){if(started&&game.winner===null)ask('対局を終了しますか？','オンライン対局中は投了してから、新しい対局へ進みます。',async()=>{if(room?.joined)await request(`/api/rooms/${room.code}/resign`,{});started=false;room=null;sessionStorage.removeItem('awai-room');setup(nextMode);});else setup(nextMode);}
$('confirm-yes').onclick=async()=>{const action=confirmAction;confirmAction=null;$('confirm-dialog').close();try{await action?.();}catch(e){toast(e.message);}};$('confirm-no').onclick=()=>{confirmAction=null;$('confirm-dialog').close();};
$('cpu-mode').onclick=()=>newSetup('cpu');$('online-mode').onclick=()=>{if(room&&!room.joined){open('room-dialog');return;}newSetup('online');};$('new-game').onclick=()=>newSetup(mode);
document.querySelectorAll('[data-side]').forEach(b=>b.onclick=()=>{setupSide=Number(b.dataset.side);document.querySelectorAll('[data-side]').forEach(x=>x.classList.toggle('selected',x===b));});
$('start-cpu').onclick=()=>{$('setup-dialog').close();startCPU();};$('rules').onclick=()=>open('rules-dialog');
document.querySelectorAll('.dialog-close,.dialog-dismiss').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('play-again').onclick=()=>{$('end-dialog').close();setup(mode);};
$('resign').onclick=()=>ask('この一局を、投了しますか？','投了すると相手の勝利で対局が終了します。',async()=>{if(room){const next=await request(`/api/rooms/${room.code}/resign`,{});await accept(next);}else{game.winner=1-side;game.resigned=side;render();showResult();}});
async function request(path,body,auth=room?.token){
 const res=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(auth?{'Authorization':'Bearer '+auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const data=await res.json();if(!res.ok)throw new Error(data.error||'接続できませんでした。');return data;
}
function saveRoom(){sessionStorage.setItem('awai-room',JSON.stringify({code:room.code,token:room.token}));}
async function enter(data){
 room={...data};mode='online';started=true;side=data.side;game=data.game;draft=data.ownPlan||[];selection=null;doubleActive=draft.length===2;locked=data.ready[side];passing=false;resolving=false;cpu=null;cpuAt=null;offset=data.serverTime-Date.now();deadline=data.deadline;saveRoom();$('setup-dialog').close();$('share-code').textContent=data.code;render();if(!data.joined)open('room-dialog');
}
async function accept(data){
 if(!room||data.version<(room.version||0)||data.game.round<game.round)return;const old=game,token=room.token;room={...data,token};offset=data.serverTime-Date.now();deadline=data.deadline;
 if(data.joined)$('room-dialog').close();
 if(data.game.round>old.round){draft=[];locked=false;doubleActive=false;passing=false;if(data.game.round===old.round+1)await animate(data.game);else{game=data.game;render();if(game.winner!==null)showResult();}}
 else{const justEnded=old.winner===null&&data.game.winner!==null;game=data.game;locked=data.ready[side];if(locked)draft=data.ownPlan||[];render();if(justEnded)showResult();}
}
let roomBusy=false;
async function createOrJoin(join){if(roomBusy)return;roomBusy=true;$('create-room').disabled=true;$('join-room').disabled=true;$('room-error').textContent='';try{const code=$('room-code').value.replace(/\s/g,'').toUpperCase();if(join&&!/^[A-F0-9]{8}$/.test(code))throw new Error('8桁のルームコードを入力してください。');const data=await request(join?`/api/rooms/${code}/join`:'/api/rooms',join?{}:{side:Number($('room-role').value)},null);await enter(data);}catch(e){$('room-error').textContent=e.message;}finally{roomBusy=false;$('create-room').disabled=false;$('join-room').disabled=false;}}
$('create-room').onclick=()=>createOrJoin(false);$('join-room').onclick=()=>createOrJoin(true);$('room-code').onkeydown=e=>{if(e.key==='Enter')void createOrJoin(true);};
$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(room.code);toast('ルームコードをコピーしました。');}catch{toast('コードを選択してコピーしてください：'+room.code);}};
setInterval(()=>{renderClock();if(!started||resolving||game.winner!==null||room)return;if(cpu===null&&Date.now()>=cpuAt){cpu=validatePlan(game,1-side,cpuPlan(game,1-side));render();resolveCPU();}if(Date.now()>=deadline){if(!locked){draft=[];locked=true;selection=null;pendingPromotion=null;$('promote-dialog').close();toast('時間切れのため、パスになりました。');}if(cpu===null)cpu=[];resolveCPU();}},200);
setInterval(async()=>{if(!room||polling||submitting||resolving||game.winner!==null)return;polling=true;try{const data=await request(`/api/rooms/${room.code}`);if(!submitting)await accept(data);}catch(e){if(Date.now()-lastErrorAt>15000){toast('接続を再試行しています：'+e.message);lastErrorAt=Date.now();}}finally{polling=false;}},1000);
render();
try{const saved=JSON.parse(sessionStorage.getItem('awai-room')||'null');if(saved?.code&&saved?.token){room=saved;const data=await request(`/api/rooms/${saved.code}`);await enter({...data,token:saved.token});if(game.winner!==null)showResult();}}catch{room=null;sessionStorage.removeItem('awai-room');toast('前のルームに接続できませんでした。新しい対局を作れます。');}
