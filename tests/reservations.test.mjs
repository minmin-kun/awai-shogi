import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,clone,legal,reservable,validatePlan,resolve} from '../src/engine.js';
const empty=()=>{const s=initial();s.board.fill(null);return s;};
const put=(s,i,t,side)=>s.board[i]={t,s:side,id:i+100};

for(const [type,from,blocker,to,clear] of [['R',4,22,40,21],['B',0,20,40,21],['L',4,22,40,21]]){
 test(`${type}: blocked reservation succeeds when the earlier mover clears the path`,()=>{
  const s=empty();put(s,from,type,1);put(s,blocker,'R',0);const m={from,to};const before=clone(s);
  assert(!legal(s,1,m));assert(reservable(s,1,m));
  const p=validatePlan(s,1,[m]);assert.deepEqual(s,before);
  const n=resolve(s,[validatePlan(s,0,[{from:blocker,to:clear}]),p]);
  assert.equal(n.board[to].t,type);assert.equal(n.board[from],null);assert(n.last[1].ok);
 });
 test(`${type}: still blocked at execution leaves piece and inventory untouched`,()=>{
  const s=empty();put(s,from,type,1);put(s,blocker,'R',0);
  const n=resolve(s,[[],validatePlan(s,1,[{from,to}])]);
  assert.deepEqual(n.board,s.board);assert.deepEqual(n.hands,s.hands);assert.equal(n.last[1].ok,false);
 });
}
test('friendly occupied target becomes a capture after the friendly piece is taken',()=>{
 const s=empty();put(s,4,'R',1);put(s,31,'P',1);put(s,30,'R',0);
 const m={from:4,to:31};assert(!legal(s,1,m));
 const n=resolve(s,[validatePlan(s,0,[{from:30,to:31}]),validatePlan(s,1,[m])]);
 assert.equal(n.board[31].id,s.board[4].id);assert.equal(n.hands[1].R,1);assert.equal(n.hands[0].P,1);
});
test('friendly occupied target still occupied does not capture or replace a friendly piece',()=>{
 const s=empty();put(s,4,'R',1);put(s,31,'P',1);
 const n=resolve(s,[[],validatePlan(s,1,[{from:4,to:31}])]);assert.deepEqual(n.board,s.board);assert.deepEqual(n.hands,s.hands);
});
test('drop onto a reserved occupied target succeeds after the target vacates',()=>{
 const s=empty();put(s,40,'P',0);s.hands[1].P=1;
 const m={drop:'P',to:40};assert(!legal(s,1,m));
 const n=resolve(s,[validatePlan(s,0,[{from:40,to:31}]),validatePlan(s,1,[m])]);assert.equal(n.board[40].s,1);assert.equal(n.hands[1].P,0);
});
test('occupied drop fizzles without consuming inventory or capturing',()=>{
 const s=empty();put(s,40,'P',0);s.hands[1].P=1;
 const n=resolve(s,[[],validatePlan(s,1,[{drop:'P',to:40}])]);assert.deepEqual(n.board,s.board);assert.deepEqual(n.hands,s.hands);
});
test('nifu is deferred, succeeds only if the earlier move removes the pawn',()=>{
 const s=empty();put(s,22,'P',1);put(s,21,'R',0);s.hands[1].P=1;
 const p=validatePlan(s,1,[{drop:'P',to:40}]);
 const fail=resolve(s,[[],p]);assert.equal(fail.hands[1].P,1);assert.equal(fail.board[40],null);
 const success=resolve(s,[validatePlan(s,0,[{from:21,to:22}]),p]);assert.equal(success.board[40].s,1);assert.equal(success.hands[1].P,0);
});
test('double move projects a conditional first move to reserve the same piece again',()=>{
 const s=empty();put(s,4,'R',1);put(s,22,'R',0);
 const p=validatePlan(s,1,[{from:4,to:40},{from:40,to:49}]);assert.equal(p[0].id,p[1].id);
 const success=resolve(s,[validatePlan(s,0,[{from:22,to:21}]),p]);assert.equal(success.board[49].id,s.board[4].id);assert(success.doubleUsed);
 const fail=resolve(s,[[],p]);assert.deepEqual(fail.board,s.board);assert(fail.doubleUsed);assert(fail.last.slice(1).every(e=>!e.ok));
});
test('second independent double move still runs after first move fizzles',()=>{
 const s=empty();put(s,4,'R',1);put(s,22,'R',0);put(s,18,'P',1);
 const n=resolve(s,[[],validatePlan(s,1,[{from:4,to:40},{from:18,to:27}])]);assert.equal(n.board[4].t,'R');assert.equal(n.board[27].t,'P');assert(!n.last[1].ok);assert(n.last[2].ok);
});
test('a first mover cannot use a path that will clear only later in the turn',()=>{
 const s=empty();put(s,76,'R',0);put(s,58,'R',1);
 const n=resolve(s,[validatePlan(s,0,[{from:76,to:40}]),validatePlan(s,1,[{from:58,to:57}])]);assert.equal(n.board[76].t,'R');assert.equal(n.board[40],null);assert(!n.last[0].ok);
});
test('double move cannot move a piece dropped by its first move, including forged ids',()=>{
 const s=empty();s.hands[1].R=1;
 for(const id of [undefined,999])assert.throws(()=>validatePlan(s,1,[{drop:'R',to:40},{from:40,to:49,id}]),/2手目/);
 const before=clone(s);assert.throws(()=>validatePlan(s,1,[{drop:'R',to:40},{from:40,to:49}]));assert.deepEqual(s,before);
});
test('double move can still drop twice or move another existing piece after a drop',()=>{
 const s=empty();s.hands[1]={R:1,P:1};put(s,18,'P',1);
 const move=validatePlan(s,1,[{drop:'R',to:40},{from:18,to:27}]);const moved=resolve(s,[[],move]);assert.equal(moved.board[40].t,'R');assert.equal(moved.board[27].t,'P');
 const drops=validatePlan(s,1,[{drop:'R',to:40},{drop:'P',to:41}]);const dropped=resolve(s,[[],drops]);assert.equal(dropped.board[40].t,'R');assert.equal(dropped.board[41].t,'P');
});
test('resolution also blocks a previously saved drop-then-move plan',()=>{
 const s=empty();s.hands[1].R=1;
 const n=resolve(s,[[],[{drop:'R',to:40},{from:40,to:49}]]);assert.equal(n.board[40].t,'R');assert.equal(n.board[49],null);assert.equal(n.last.at(-1).reasonCode,'fresh_drop');assert(n.doubleUsed);
});
test('reservations still reject impossible geometry, foreign pieces, missing inventory and dead drops',()=>{
 const s=initial();for(const m of [{from:54,to:44},{from:18,to:27},{from:54,to:54},{from:-1,to:20},{drop:'P',to:40},{from:54,to:45,promote:true},null])assert.throws(()=>validatePlan(s,0,[m]));
 s.hands[0]={P:1,N:1};assert(!reservable(s,0,{drop:'P',to:0}));assert(!reservable(s,0,{drop:'N',to:9}));
});
