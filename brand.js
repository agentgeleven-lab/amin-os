// Theme-colored vector interpretation of the approved orbit-star concept.
export function createBrandMark(document=globalThis.document){
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({viewBox:'0 -2 48 40',preserveAspectRatio:'xMidYMid meet','aria-hidden':'true',focusable:'false',class:'amin-orbit-mark'}))svg.setAttribute(key,value);
 const orbit=document.createElementNS(ns,'path');
 for(const [key,value]of Object.entries({d:'M24 5 C37 -2 47 1 43 11 C41 17 33 25 25 30 M16 12 C8 18 2 25 5 31 C9 39 25 33 32 28',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round'}))orbit.setAttribute(key,value);
 const star=document.createElementNS(ns,'path');star.setAttribute('d','M23 9 L26.5 18 L35 21 L26.5 24.5 L23 33 L19.5 24.5 L11 21 L19.5 18 Z');star.setAttribute('fill','currentColor');
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
