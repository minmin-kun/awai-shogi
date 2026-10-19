import test from 'node:test';import assert from 'node:assert/strict';
import {initial,apply,validatePlan,resolve,clone} from '../src/engine.js';
const empty=()=>{const s=initial();s.board.fill(null);return s;};
const put=(s,i,t,side)=>s.board[i]={id:i+100,t,s:side};
test('blocked path and friendly destination have different reasons and no side effects',()=>{const s=empty();put(s,4,'R',1);put(s,22,'P',1);const before=clone(s);assert.equal(apply(s,1,{from:4,to:40}).reasonCode,'blocked');assert.equal(apply(s,1,{from:4,to:22}).reasonCode,'friendly_target');assert.deepEqual(s,before);});
test('captured piece is explained in resolved event and history',()=>{const s=empty();put(s,4,'R',1);put(s,13,'R',0);const n=resolve(s,[validatePlan(s,0,[{from:13,to:4}]),validatePlan(s,1,[{from:4,to:40}])]);assert.equal(n.last[1].reasonCode,'captured');assert(n.history[0].events[1].reason.includes('取られ'));});
test('empty source after a capture is distinguishable from failed first double move',()=>{const s=empty();put(s,4,'R',1);assert.equal(apply(s,1,{from:40,to:49,id:104}).reasonCode,'source_missing');s.board[4]=null;assert.equal(apply(s,1,{from:40,to:49,id:104}).reasonCode,'captured');});
test('drop failure explains occupancy, nifu, missing inventory and dead drop',()=>{const s=empty();s.hands[1]={P:1};put(s,40,'R',0);assert.equal(apply(s,1,{drop:'P',to:40}).reasonCode,'occupied');put(s,22,'P',1);assert.equal(apply(s,1,{drop:'P',to:31}).reasonCode,'nifu');assert.equal(apply(s,1,{drop:'B',to:31}).reasonCode,'inventory');assert.equal(apply(s,1,{drop:'P',to:80}).reasonCode,'dead_drop');});
