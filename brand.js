// Orbit and star share (24, 20); tips stay inside the ellipse with clear spacing.
export function createBrandMark(document=globalThis.document){
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 48 40',preserveAspectRatio:'xMidYMid meet','aria-hidden':'true',focusable:'false',class:'amin-orbit-mark'}))svg.setAttribute(key,value);
 const orbit=document.createElementNS(ns,'ellipse');
 for(const [key,value]of Object.entries({cx:'24',cy:'20',rx:'21',ry:'10',transform:'rotate(-35 24 20)',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round'}))orbit.setAttribute(key,value);
 const star=document.createElementNS(ns,'path');star.setAttribute('d','M24 11 L26.5 17.5 L33 20 L26.5 22.5 L24 29 L21.5 22.5 L15 20 L21.5 17.5 Z');star.setAttribute('fill','currentColor');
 svg.append(orbit,star);return svg;
}

export function createCollapseMark(document=globalThis.document){
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 0 24 24',class:'amin-collapse-mark','aria-hidden':'true',focusable:'false',preserveAspectRatio:'xMidYMid meet'}))svg.setAttribute(key,value);
 const path=document.createElementNS(ns,'path');
 for(const [key,value]of Object.entries({d:'M6 9 L12 15 L18 9',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round'}))path.setAttribute(key,value);
 svg.append(path);return svg;
}
