export function pinchCamera(base,start,current,min=.1,max=3){
 const middle=pair=>({x:(pair[0].x+pair[1].x)/2,y:(pair[0].y+pair[1].y)/2});
 const distance=pair=>Math.hypot(pair[1].x-pair[0].x,pair[1].y-pair[0].y);
 const a=middle(start),b=middle(current),d=distance(start);
 const zoom=Math.max(min,Math.min(max,base.zoom*(d>0?distance(current)/d:1))),ratio=zoom/base.zoom;
 return {zoom,x:b.x-(a.x-base.x)*ratio,y:b.y-(a.y-base.y)*ratio};
}

// Preview during the gesture; commit once after every finger lifts so rendering
// cannot replace the SVG and break pointer capture midway through a pinch.
export function attachPinch(svg,{point,getCamera,start,preview,commit}){
 const touches=new Map();let session=null,base,origin,view,suppressClick=false,cancelled=false;
 const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
 const rebase=()=>{base={...view};origin=[...touches.values()].slice(0,2);};
 svg.addEventListener('pointerdown',e=>{
  if(!touches.size)suppressClick=false;
  if(e.pointerType!=='touch')return;
  touches.set(e.pointerId,point(e));svg.setPointerCapture(e.pointerId);
  if(touches.size<2&&!session)return;
  if(!session){view={...getCamera()};session={original:{...view}};cancelled=false;start();}
  rebase();suppressClick=true;stop(e);
 },true);
 svg.addEventListener('pointermove',e=>{
  if(!touches.has(e.pointerId))return;
  touches.set(e.pointerId,point(e));if(!session)return;stop(e);if(cancelled)return;
  const current=[...touches.values()].slice(0,2);
  view=current.length===2?pinchCamera(base,origin,current):{...base,x:base.x+current[0].x-origin[0].x,y:base.y+current[0].y-origin[0].y};
  preview(view);
 },true);
 const finish=e=>{
  if(!touches.has(e.pointerId))return;touches.delete(e.pointerId);
  if(!session)return;stop(e);
  if(e.type!=='pointerup'){cancelled=true;view={...session.original};preview(view);}
  if(touches.size){rebase();return;}
  session=null;if(!cancelled)commit(view);
 };
 for(const name of ['pointerup','pointercancel','lostpointercapture'])svg.addEventListener(name,finish,true);
 svg.addEventListener('click',e=>{if(suppressClick){stop(e);suppressClick=false;}},true);
 return {active:()=>!!session};
}
