// Filled, tapered ribbons keep their silhouette and theme color at every scale.
function orbitRibbon(start,end,thickness){
 const rotation=-32*Math.PI/180,cos=Math.cos(rotation),sin=Math.sin(rotation);
 const edge=(t,side)=>{
  const angle=(start+(end-start)*t)*Math.PI/180;
  const x=43*Math.cos(angle),y=20*Math.sin(angle);
  const nx=Math.cos(angle)/43,ny=Math.sin(angle)/20,length=Math.hypot(nx,ny);
  const half=thickness*Math.pow(Math.sin(Math.PI*t),.75)/2;
  const px=x+side*nx/length*half,py=y+side*ny/length*half;
  return [48+px*cos-py*sin,40+px*sin+py*cos];
 };
 const points=[];
 for(let i=0;i<=24;i++)points.push(edge(i/24,1));
 for(let i=23;i>0;i--)points.push(edge(i/24,-1));
 const fmt=p=>p.map(n=>n.toFixed(3)).join(' ');
 let path='M'+fmt(points[0]);
 // Smooth cubic outlines rather than uniform-width strokes.
 for(let i=0;i<points.length;i++){
  const a=points[(i-1+points.length)%points.length],b=points[i],c=points[(i+1)%points.length],d=points[(i+2)%points.length];
  path+=' C'+fmt([b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6])+' '+fmt([c[0]-(d[0]-b[0])/6,c[1]-(d[1]-b[1])/6])+' '+fmt(c);
 }
 return path+' Z';
}
export function createBrandMark(document=globalThis.document,{compact=false}={}){
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 96 80',preserveAspectRatio:'xMidYMid meet','aria-hidden':'true',focusable:'false',class:'amin-orbit-mark'}))svg.setAttribute(key,value);
 const add=d=>{const path=document.createElementNS(ns,'path');path.setAttribute('d',d);path.setAttribute('fill','currentColor');svg.append(path);};
 // Separate rear and foreground arcs leave breathing room around the central star.
 add(orbitRibbon(193,350,compact?3:2.1));
 add(compact
  ?'M48 22 Q51 36 63 40 Q51 44 48 58 Q45 44 33 40 Q45 36 48 22 Z'
  :'M48 20 Q50.6 36.3 64.5 40 Q50.6 43.7 48 60 Q45.4 43.7 31.5 40 Q45.4 36.3 48 20 Z');
 add(orbitRibbon(13,170,compact?3.7:3.3));
 return svg;
}

export function createCollapseMark(document=globalThis.document){
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 24 24',class:'amin-collapse-mark','aria-hidden':'true',focusable:'false',preserveAspectRatio:'xMidYMid meet'}))svg.setAttribute(key,value);
 const path=document.createElementNS(ns,'path');
 for(const [key,value]of Object.entries({d:'M6 9 L12 15 L18 9',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'}))path.setAttribute(key,value);
 svg.append(path);return svg;
}
