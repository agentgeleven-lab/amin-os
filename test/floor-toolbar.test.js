import test from 'node:test';
import assert from 'node:assert/strict';
import {moveFloorButton,placeFloorButtons} from '../settings/floor-toolbar.js';

test('floor drag places a button before or after the target without changing other order',()=>{
 const order=['map','status','characters','dice'];
 assert.deepEqual(moveFloorButton(order,'dice','status'),['map','dice','status','characters']);
 assert.deepEqual(moveFloorButton(order,'map','characters',true),['status','characters','map','dice']);
 assert.deepEqual(order,['map','status','characters','dice']);
});
test('floor drag safely ignores missing and identical targets',()=>{
 const order=['map','status','dice'];
 for(const [id,target] of [['map','map'],['unknown','status'],['dice','unknown']])assert.deepEqual(moveFloorButton(order,id,target),order);
});

class ButtonNode{
 constructor(){this.children=[];this.parentNode=null;this.moves=0;}
 get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null;}
 insertBefore(node,anchor){if(node.parentNode)node.parentNode.children.splice(node.parentNode.children.indexOf(node),1);const index=anchor?this.children.indexOf(anchor):this.children.length;this.children.splice(index,0,node);node.parentNode=this;this.moves++;}
}
test('refresh keeps buttons mounted until their requested position changes',()=>{
 const toolbar=new ButtonNode(),overflow=new ButtonNode(),a=new ButtonNode(),b=new ButtonNode(),more=new ButtonNode();
 toolbar.insertBefore(more,null);placeFloorButtons(toolbar,[a,b],more);toolbar.moves=0;
 for(let i=0;i<20;i++)placeFloorButtons(toolbar,[a,b],more);
 assert.equal(toolbar.moves,0);assert.deepEqual(toolbar.children,[a,b,more]);
 placeFloorButtons(toolbar,[b,a],more);assert.equal(toolbar.moves,1);assert.deepEqual(toolbar.children,[b,a,more]);
 placeFloorButtons(toolbar,[a],more);placeFloorButtons(overflow,[b]);assert.deepEqual(toolbar.children,[a,more]);assert.deepEqual(overflow.children,[b]);
 toolbar.moves=overflow.moves=0;placeFloorButtons(toolbar,[a],more);placeFloorButtons(overflow,[b]);assert.equal(toolbar.moves+overflow.moves,0);
});
