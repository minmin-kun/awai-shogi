import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,clone} from '../src/engine.js';
import {nifuWarnings} from '../src/planning.js';
const empty=()=>{const game=initial();game.board.fill(null);game.hands[0]={P:2,G:1};game.hands[1]={P:2};return game;};
const put=(game,at,t,side)=>game.board[at]={id:at+100,t,s:side};
test('only a pawn drop on a file with an own unpromoted pawn warns',()=>{
 const game=empty();put(game,54,'P',0);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'P',to:27}]),[{index:0,to:27}]);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'P',to:28}]),[]);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'G',to:27}]),[]);
 assert.deepEqual(nifuWarnings(game,0,[{from:54,to:45,id:154}]),[]);
});
test('opponent pawns and own promoted pawns are not nifu',()=>{
 const game=empty();put(game,54,'+P',0);put(game,18,'P',1);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'P',to:27}]),[]);
});
test('the check works for either side and does not mutate the game or plan',()=>{
 const game=empty();put(game,18,'P',1);const plan=[{drop:'P',to:36}],before=clone(game);
 assert.deepEqual(nifuWarnings(game,1,plan),[{index:0,to:36}]);assert.deepEqual(game,before);assert.deepEqual(plan,[{drop:'P',to:36}]);
});
test('promoting the first pawn clears nifu for a second-move drop',()=>{
 const game=empty();put(game,18,'P',0);
 assert.deepEqual(nifuWarnings(game,0,[{from:18,to:9,id:118,promote:true},{drop:'P',to:54}]),[]);
 assert.deepEqual(nifuWarnings(game,0,[{from:18,to:9,id:118},{drop:'P',to:54}]),[{index:1,to:54}]);
});
test('a first drop is counted when checking a second drop on the same file',()=>{
 const game=empty();assert.deepEqual(nifuWarnings(game,0,[{drop:'P',to:27},{drop:'P',to:36}]),[{index:1,to:36}]);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'P',to:28},{drop:'P',to:36}]),[]);
});
test('blocked movement and occupied non-pawn drops do not warn',()=>{
 const game=empty();put(game,72,'R',0);put(game,36,'P',0);put(game,27,'G',1);
 assert.deepEqual(nifuWarnings(game,0,[{from:72,to:0,id:172}]),[]);
 assert.deepEqual(nifuWarnings(game,0,[{drop:'G',to:27}]),[]);
 assert.deepEqual(nifuWarnings(game,0,[]),[]);
});
