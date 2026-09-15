import test from 'node:test';
import assert from 'node:assert/strict';
import {attachPinch,pinchCamera} from '../src/ui/pinch.js';
test('pinch keeps its world anchor under the moving midpoint and clamps zoom',()=>{
 const base={x:10,y:20,zoom:1},start=[{x:50,y:100},{x:150,y:100}];
 const next=pinchCamera(base,start,[{x:25,y:130},{x:225,y:130}]);
 assert.equal(next.zoom,2);assert.equal((125-next.x)/next.zoom,90);assert.equal((130-next.y)/next.zoom,80);
 assert.equal(pinchCamera(base,start,[{x:-1000,y:0},{x:1000,y:0}]).zoom,3);
 assert.equal(pinchCamera(base,start,[{x:0,y:0},{x:0,y:0}]).zoom,.1);
 assert.deepEqual(base,{x:10,y:20,zoom:1});
});
function fixture(){
 const handlers={},commits=[],previews=[];let starts=0;
 const svg={addEventListener(name,fn){handlers[name]=fn;},setPointerCapture(){}};
 const api=attachPinch(svg,{point:e=>({x:e.clientX,y:e.clientY}),getCamera:()=>({x:0,y:0,zoom:1}),start:()=>starts++,preview:v=>previews.push({...v}),commit:v=>commits.push({...v})});
 const emit=(type,id,x=0,y=0,pointerType='touch')=>{const e={type,pointerId:id,clientX:x,clientY:y,pointerType,isPrimary:id===1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};handlers[type](e);return e;};
 return {emit,api,commits,previews,starts:()=>starts};
}
test('second non-primary finger starts pinch, then remaining finger pans until final commit',()=>{
 const f=fixture();assert.equal(f.emit('pointerdown',1).stopped,undefined);assert.equal(f.emit('pointerdown',2,100).stopped,true);
 f.emit('pointermove',2,200);assert.equal(f.previews.at(-1).zoom,2);assert.equal(f.commits.length,0);assert.equal(f.starts(),1);
 f.emit('pointerup',2,200);f.emit('pointermove',1,30,10);assert.deepEqual(f.previews.at(-1),{x:30,y:10,zoom:2});
 assert.equal(f.commits.length,0);f.emit('pointerup',1,30,10);assert.deepEqual(f.commits,[{x:30,y:10,zoom:2}]);
 assert.equal(f.api.active(),false);assert.equal(f.emit('click',1).stopped,true);
 assert.equal(f.emit('pointerdown',1,0,0,'mouse').stopped,undefined);
});
test('cancel or lost capture restores the original view and cannot commit edits or camera',()=>{
 for(const event of ['pointercancel','lostpointercapture']){
  const f=fixture();f.emit('pointerdown',1);f.emit('pointerdown',2,100);f.emit('pointermove',2,200);
  f.emit(event,2);f.emit('pointermove',1,60);f.emit('pointerup',1);
  assert.deepEqual(f.previews.at(-1),{x:0,y:0,zoom:1});assert.equal(f.commits.length,0);assert.equal(f.api.active(),false);
 }
});
