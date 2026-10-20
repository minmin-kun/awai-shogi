import test from 'node:test';import assert from 'node:assert/strict';
import {initial,clone,validatePlan} from '../src/engine.js';
import {projectPlan,draftEditContext,draftPieceSelection,replacementDestination} from '../src/planning.js';
const empty=()=>{const s=initial();s.board.fill(null);return s;};
const put=(s,i,t,side)=>s.board[i]={id:i+100,t,s:side};
test('a new destination replaces an unconfirmed reservation from its original square',()=>{
 const s=initial(),plan=validatePlan(s,0,[{from:70,to:71}]);const result=replacementDestination(s,0,plan,69);
 assert.deepEqual(result.draft,[]);assert.equal(result.move.from,70);assert.equal(result.move.to,69);assert.equal(result.move.id,s.board[70].id);assert.equal(result.board.board[70].t,'R');
 assert.doesNotThrow(()=>validatePlan(s,0,[result.move]));
});
test('selecting another own piece or the original source cancels the previous reservation',()=>{
 const s=initial(),plan=validatePlan(s,0,[{from:70,to:71}]);
 for(const at of [54,70]){const r=draftPieceSelection(s,0,plan,at);assert.deepEqual(r.draft,[]);assert.equal(r.selection.from,at);assert.equal(r.piece.id,s.board[at].id);}
});
test('an unrelated square or the same destination does not change the reservation',()=>{
 const s=initial(),plan=validatePlan(s,0,[{from:70,to:71}]);assert.equal(replacementDestination(s,0,plan,60),null);assert.equal(replacementDestination(s,0,plan,71),null);assert.equal(draftPieceSelection(s,0,plan,40),null);
});
test('editing a second move keeps the first and uses the projected original square',()=>{
 const s=empty();put(s,4,'R',1);const plan=validatePlan(s,1,[{from:4,to:13},{from:13,to:22}]);
 const r=replacementDestination(s,1,plan,31);assert.deepEqual(r.draft,[plan[0]]);assert.equal(r.move.from,13);assert.equal(r.move.id,s.board[4].id);assert.equal(r.board.board[4],null);assert.equal(r.board.board[13].t,'R');
 assert.doesNotThrow(()=>validatePlan(s,1,[...r.draft,r.move]));
});
test('selecting a first move source clears both dependent moves',()=>{
 const s=empty();put(s,4,'R',1);const plan=validatePlan(s,1,[{from:4,to:13},{from:13,to:22}]);
 const r=draftPieceSelection(s,1,plan,4);assert.deepEqual(r.draft,[]);assert.equal(r.selection.from,4);assert.equal(r.board.board[13],null);
});
test('selecting the first ghost or another piece replaces only the second move',()=>{
 const s=empty();put(s,4,'R',1);put(s,18,'P',1);const plan=validatePlan(s,1,[{from:4,to:13},{from:13,to:22}]);
 for(const at of [13,18]){const r=draftPieceSelection(s,1,plan,at);assert.deepEqual(r.draft,[plan[0]]);assert.equal(r.selection.from,at);}
});
test('editing the first source of an independent double also clears the second reservation',()=>{
 const s=initial(),plan=validatePlan(s,1,[{from:18,to:27},{from:19,to:28}]);
 assert.deepEqual(draftPieceSelection(s,1,plan,18).draft,[]);assert.deepEqual(draftPieceSelection(s,1,plan,20).draft,[plan[0]]);
});
test('promotion state from a kept first move is preserved when editing the second',()=>{
 const s=empty();put(s,9,'P',0);s.initialSecond=0;const plan=validatePlan(s,0,[{from:9,to:0},{from:0,to:1}]);
 const r=replacementDestination(s,0,plan,9);assert.equal(r.board.board[0].t,'+P');assert.doesNotThrow(()=>validatePlan(s,0,[...r.draft,r.move]));
});
test('a changed destination does not inherit an obsolete promotion choice',()=>{
 const s=empty();put(s,40,'R',0);const plan=validatePlan(s,0,[{from:40,to:4,promote:true}]);const r=replacementDestination(s,0,plan,31);
 assert.equal(r.move.promote,undefined);assert.doesNotThrow(()=>validatePlan(s,0,[r.move]));
});
test('editing a drop restores inventory without mutating the original board or plan',()=>{
 const s=empty();s.hands[0].P=1;const plan=validatePlan(s,0,[{drop:'P',to:40}]),before=clone(s),original=clone(plan);
 assert.equal(projectPlan(s,0,plan).hands[0].P,0);const r=replacementDestination(s,0,plan,41);assert.equal(r.board.hands[0].P,1);assert.equal(r.move.drop,'P');assert.deepEqual(s,before);assert.deepEqual(plan,original);assert.equal(draftEditContext(s,0,[]),null);
});
