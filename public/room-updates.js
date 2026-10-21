export const ROOM_UPDATE_PROTOCOL='room-delta-v1';
const roomUpdateEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const roomUpdateDigest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');
const roomUpdateSafeKey=key=>!['__proto__','constructor','prototype'].includes(key);
function roomUpdateChanges(before,after,exclude=[]){
 const set={},remove=[];
 for(const key of Object.keys(after))if(!exclude.includes(key)&&!roomUpdateEqual(before[key],after[key]))set[key]=after[key];
 for(const key of Object.keys(before))if(!exclude.includes(key)&&!Object.hasOwn(after,key))remove.push(key);
 return {set,remove};
}
function roomUpdateValidate(state){
 if(!state||!/^[A-F0-9]{8}$/.test(state.code)||![0,1].includes(state.side)||!Number.isInteger(state.version)||state.version<0)throw Error('Invalid room snapshot');
 const game=state.game;
 if(!game||!Array.isArray(game.board)||game.board.length!==81||!Array.isArray(game.hands)||game.hands.length!==2||!Array.isArray(game.history)||!Number.isInteger(game.round)||game.round<1||game.history.length!==game.round-1)throw Error('Invalid game snapshot');
 for(let i=0;i<game.history.length;i++)if(game.history[i]?.round!==i+1)throw Error('Invalid history sequence');
}

// The cursor fits in a hibernating socket attachment: board/metadata + history
// length and digest, never the entire growing history.
export async function encodeRoomUpdate(previous,state,forceSnapshot=false){
 roomUpdateValidate(state);
 const history=state.game.history,seq=(previous?.seq||0)+1;
 const sameRoom=previous?.state.code===state.code&&previous.state.side===state.side;
 const appendOnly=sameRoom&&previous.historyLength<=history.length&&previous.historyDigest===await roomUpdateDigest(history.slice(0,previous.historyLength));
 const summary=structuredClone(state);delete summary.game.history;
 const cursor={seq,state:summary,historyLength:history.length,historyDigest:appendOnly&&previous.historyLength===history.length?previous.historyDigest:await roomUpdateDigest(history)};
 if(forceSnapshot||!appendOnly)return {cursor,update:{protocol:ROOM_UPDATE_PROTOCOL,type:'snapshot',seq,state}};
 const board=[];
 for(let i=0;i<81;i++)if(!roomUpdateEqual(previous.state.game.board[i],state.game.board[i]))board.push([i,state.game.board[i]]);
 const update={protocol:ROOM_UPDATE_PROTOCOL,type:'delta',seq,base:previous.seq,code:state.code,side:state.side,
  changes:roomUpdateChanges(previous.state,state,['code','side','game']),
  game:roomUpdateChanges(previous.state.game,state.game,['board','history'])};
 if(board.length)update.board=board;
 if(history.length!==previous.historyLength)update.history={from:previous.historyLength,append:history.slice(previous.historyLength)};
 return {cursor,update};
}

function roomUpdateApplyFields(target,changes,exclude){
 if(!changes||typeof changes.set!=='object'||changes.set===null||Array.isArray(changes.set)||!Array.isArray(changes.remove))throw Error('Invalid delta fields');
 for(const [key,value] of Object.entries(changes.set)){
  if(!roomUpdateSafeKey(key)||exclude.includes(key))throw Error('Invalid delta key');target[key]=structuredClone(value);
 }
 for(const key of changes.remove){if(typeof key!=='string'||!roomUpdateSafeKey(key)||exclude.includes(key))throw Error('Invalid removed key');delete target[key];}
}

// Always construct a new state. The renderer animates/mutates its own copy;
// neither an old frame nor a partially applied patch can poison the baseline.
export function decodeRoomUpdate(previous,update){
 if(update?.protocol!==ROOM_UPDATE_PROTOCOL||!Number.isSafeInteger(update.seq)||update.seq<1)throw Error('Unknown room update');
 if(previous&&update.seq<=previous.seq)return {...previous,ignored:true};
 let state;
 if(update.type==='snapshot'){state=structuredClone(update.state);}
 else if(update.type==='delta'){
  if(!previous||update.base!==previous.seq||update.seq!==previous.seq+1||update.code!==previous.state.code||update.side!==previous.state.side)throw Error('Room delta baseline mismatch');
  state=structuredClone(previous.state);
  roomUpdateApplyFields(state,update.changes,['code','side','game']);
  roomUpdateApplyFields(state.game,update.game,['board','history']);
  if(update.board!==undefined){
   if(!Array.isArray(update.board))throw Error('Invalid board delta');const seen=new Set();
   for(const cell of update.board){
    if(!Array.isArray(cell)||cell.length!==2||!Number.isInteger(cell[0])||cell[0]<0||cell[0]>=81||seen.has(cell[0]))throw Error('Invalid board cell');
    seen.add(cell[0]);state.game.board[cell[0]]=structuredClone(cell[1]);
   }
  }
  if(update.history!==undefined){
   if(update.history.from!==state.game.history.length||!Array.isArray(update.history.append))throw Error('History delta baseline mismatch');
   state.game.history.push(...structuredClone(update.history.append));
  }
  if(state.version<previous.state.version||state.game.round<previous.state.game.round)throw Error('Room state moved backwards');
 }else throw Error('Unknown room update type');
 roomUpdateValidate(state);
 if(previous&&(state.code!==previous.state.code||state.side!==previous.state.side))throw Error('Room identity changed');
 if(previous&&(state.version<previous.state.version||state.game.round<previous.state.game.round))throw Error('Room state moved backwards');
 return {seq:update.seq,state,ignored:false};
}
