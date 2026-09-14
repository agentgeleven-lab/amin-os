// Presentation coordinates only. These values never enter chat or model data.
export function clampPosition(p,width,height){
    const clamp=(n,min,max)=>Math.max(min,Math.min(Number.isFinite(n)?n:min,Math.max(min,max)));
    return {x:clamp(p?.x,8,width-134),y:clamp(p?.y,8,height-60)};
}
export function drawerPlacement(p,width,height,options={}){
    const w=Math.max(0,Math.min(options.width??448,width-16)),above=Math.max(0,p.y-20),below=Math.max(0,height-p.y-72);
    const upwards=above>=260||above>=below;
    const h=Math.min(options.height??720,upwards?above:below);
    return {width:w,height:h,x:Math.max(8,Math.min(p.x+126-w,width-w-8)),y:upwards?p.y-h-12:p.y+64};
}

export function resizedHeight(start,delta,edge,available){
 const max=Math.max(0,Number.isFinite(available)?available:0),min=Math.min(220,max);
 const value=(Number.isFinite(start)?start:min)+(Number.isFinite(delta)?delta:0)*(edge==='top'?-1:1);
 return Math.max(min,Math.min(max,value));
}
