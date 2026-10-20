import {clone,projectReservation,reservable} from './engine.js';

export function projectPlan(game,side,plan){
 const state=clone(game);for(const move of plan)projectReservation(state,side,move);return state;
}

// Rewind the chosen reservation and every subsequent dependent reservation.
export function draftEditContext(game,side,plan,index=plan.length-1){
 if(index<0||index>=plan.length)return null;
 const draft=plan.slice(0,index),board=projectPlan(game,side,draft),move=plan[index];
 const selection=move.drop?{drop:move.drop}:{from:move.from,id:move.id};
 return {draft,board,selection};
}

export function draftPieceSelection(game,side,plan,at){
 if(!plan.length)return null;
 const source=plan.findIndex(m=>!m.drop&&m.from===at);
 const context=draftEditContext(game,side,plan,source<0?plan.length-1:source);
 const piece=context.board.board[at];if(piece?.s!==side)return null;
 return {...context,selection:{from:at,id:piece.id},piece};
}

export function replacementDestination(game,side,plan,to){
 const context=draftEditContext(game,side,plan);if(!context||to===plan.at(-1).to)return null;
 const move={...context.selection,to};if(!reservable(context.board,side,move))return null;
 // A changed destination gets a fresh promotion choice in the UI.
 return {...context,move};
}
