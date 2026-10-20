import test from 'node:test';import assert from 'node:assert/strict';
import {initial,LABELS,pieceInfo,legal} from '../src/engine.js';
for(const type of Object.keys(LABELS))test(`${type}: movement diagram matches the actual rules in both orientations`,()=>{
 const info=pieceInfo(type);assert(info.name);assert(info.description);assert.equal(info.label,LABELS[type]);
 for(const side of [0,1]){const s=initial();s.board.fill(null);s.board[40]={id:100,t:type,s:side};
  for(let y=-4;y<=4;y++)for(let x=-4;x<=4;x++){
   if(!x&&!y)continue;
   const shown=info.steps.some(([dx,dy])=>x===dx&&y===dy)||info.rays.some(([dx,dy])=>Array.from({length:4},(_,i)=>i+1).some(n=>x===dx*n&&y===dy*n));
   const direction=side===0?1:-1,to=40+(y*9+x)*direction;assert.equal(legal(s,side,{from:40,to}),shown,`${type}, side ${side}, offset ${x},${y}`);
  }
 }
});
test('promotion guides point to the correct promoted piece, and returned diagrams are independent',()=>{
 for(const t of ['R','B','S','N','L','P'])assert.equal(pieceInfo(t).promotion,'+'+t);
 for(const t of ['K','G','+R','+B','+S','+N','+L','+P'])assert.equal(pieceInfo(t).promotion,undefined);
 const a=pieceInfo('G');a.steps[0][0]=99;assert.notEqual(pieceInfo('G').steps[0][0],99);assert.equal(pieceInfo('unknown'),null);
});
