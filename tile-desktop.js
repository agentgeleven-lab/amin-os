import {TILE_KEY,defaultTiles,normalizeTiles,moveTile} from './tile-layout.js';

export function createTileDesktop({home,cards,apps,openApp,onLayout}){
 const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
 let layout;try{layout=normalizeTiles(JSON.parse(localStorage.getItem(TILE_KEY)));}catch{layout=defaultTiles();}
 let editing=false,selected=layout[0].id,gesture=null,hold=null,ghost=null,suppress=false;
 const buttons=new Map([...cards.children].map(b=>[b.dataset.tile,b]));
 const top=make('div','amin-start-heading'),title=make('h2','','开始'),edit=make('button','amin-edit-tiles','编辑布局');
 edit.type='button';edit.setAttribute('aria-pressed','false');top.append(title,edit);home.prepend(top);
 const editor=make('div','amin-tile-editor');editor.hidden=true;
 const choice=make('select','');choice.setAttribute('aria-label','选择磁贴');
 for(const app of apps){const o=make('option','',app.name);o.value=app.id;choice.append(o);}
 const sizes=make('select','');sizes.setAttribute('aria-label','磁贴尺寸');
 for(const [value,name]of [['small','小'],['medium','中'],['wide','宽']]){const o=make('option','',name);o.value=value;sizes.append(o);}
 const before=make('button','','前移'),after=make('button','','后移');before.type=after.type='button';
 const hint=make('p','amin-tile-hint','长按磁贴可调整布局');hint.setAttribute('role','status');
 editor.append(choice,sizes,before,after);top.after(editor);home.append(hint);
 const save=()=>{try{localStorage.setItem(TILE_KEY,JSON.stringify(layout));hint.textContent='布局已保存';}catch{hint.textContent='本次布局已应用，浏览器未允许保存';}};
 function syncSelection(){choice.value=selected;sizes.value=layout.find(t=>t.id===selected).size;buttons.forEach((b,id)=>b.classList.toggle('is-selected',editing&&id===selected));const index=layout.findIndex(t=>t.id===selected);before.disabled=index===0;after.disabled=index===layout.length-1;}
 function render(){for(const t of layout){const b=buttons.get(t.id);b.dataset.size=t.size;cards.append(b);}syncSelection();onLayout();}
 function setEditing(value){editing=value;home.classList.toggle('amin-tiles-editing',value);editor.hidden=!value;edit.textContent=value?'完成':'编辑布局';edit.setAttribute('aria-pressed',String(value));hint.textContent=value?'拖动磁贴调整顺序，或选择尺寸':'长按磁贴可调整布局';syncSelection();onLayout();}
 edit.onclick=()=>setEditing(!editing);
 choice.onchange=()=>{selected=choice.value;syncSelection();};
 sizes.onchange=()=>{layout=layout.map(t=>t.id===selected?{...t,size:sizes.value}:t);render();save();};
 function step(delta){const i=layout.findIndex(t=>t.id===selected),target=layout[i+delta];if(!target)return;layout=moveTile(layout,selected,target.id,delta>0);render();save();}
 before.onclick=()=>step(-1);after.onclick=()=>step(1);
 function clearGesture(){clearTimeout(hold);hold=null;ghost?.remove();ghost=null;buttons.forEach(b=>b.classList.remove('is-dragging','is-drop-target'));gesture=null;}
 function hit(x,y){const b=document.elementFromPoint(x,y)?.closest('[data-tile]');return b&&cards.contains(b)?b:null;}
 cards.addEventListener('click',e=>{const b=e.target.closest('[data-tile]');if(!b)return;if(suppress){suppress=false;e.preventDefault();return;}if(editing){selected=b.dataset.tile;syncSelection();}else openApp(b.dataset.tile);});
 cards.addEventListener('contextmenu',e=>e.preventDefault());
 cards.addEventListener('pointerdown',e=>{
  const b=e.target.closest('[data-tile]');if(!b||b.disabled||!e.isPrimary||e.button!==0)return;
  suppress=false;gesture={id:e.pointerId,tile:b.dataset.tile,x:e.clientX,y:e.clientY,moved:false,drag:editing,target:null,after:false};
  if(editing){selected=b.dataset.tile;syncSelection();cards.setPointerCapture(e.pointerId);e.preventDefault();}
  else hold=setTimeout(()=>{if(!gesture)return;selected=b.dataset.tile;setEditing(true);suppress=true;gesture.drag=true;cards.setPointerCapture(e.pointerId);},450);
 });
 cards.addEventListener('pointermove',e=>{
  if(!gesture||gesture.id!==e.pointerId)return;
  if(Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)<7&&!gesture.moved)return;
  clearTimeout(hold);hold=null;
  if(!gesture.drag){gesture=null;return;}
  gesture.moved=true;suppress=true;e.preventDefault();
  if(!ghost){const b=buttons.get(gesture.tile),r=b.getBoundingClientRect();ghost=b.cloneNode(true);ghost.removeAttribute('data-tile');ghost.classList.add('amin-tile-ghost');ghost.setAttribute('aria-hidden','true');ghost.tabIndex=-1;Object.assign(ghost.style,{width:r.width+'px',height:r.height+'px'});document.getElementById('amin-os').append(ghost);b.classList.add('is-dragging');}
  ghost.style.left=e.clientX+12+'px';ghost.style.top=e.clientY+12+'px';
  const target=hit(e.clientX,e.clientY);buttons.forEach(b=>b.classList.toggle('is-drop-target',b===target&&b.dataset.tile!==gesture.tile));
  gesture.target=target?.dataset.tile??null;
  if(target){const r=target.getBoundingClientRect();gesture.after=e.clientY>r.y+r.height*.7||(e.clientY>r.y+r.height*.3&&e.clientX>r.x+r.width*.5);}
  const r=home.getBoundingClientRect();if(e.clientY>r.bottom-40)home.scrollTop+=12;else if(e.clientY<r.top+40)home.scrollTop-=12;
 });
 cards.addEventListener('pointerup',e=>{if(gesture?.id!==e.pointerId)return;const g=gesture;clearGesture();if(g.moved&&g.target){layout=moveTile(layout,g.tile,g.target,g.after);render();save();}if(cards.hasPointerCapture(e.pointerId))cards.releasePointerCapture(e.pointerId);});
 cards.addEventListener('pointercancel',()=>{suppress=true;clearGesture();});
 cards.addEventListener('lostpointercapture',clearGesture);
 cards.addEventListener('keydown',e=>{if(!editing)return;const b=e.target.closest('[data-tile]');if(!b)return;selected=b.dataset.tile;if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(e.key)){e.preventDefault();step(['ArrowLeft','ArrowUp'].includes(e.key)?-1:1);b.focus();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(false);edit.focus();}});
 const observer=new ResizeObserver(()=>{const width=cards.clientWidth,gap=parseFloat(getComputedStyle(cards).columnGap)||10;cards.style.setProperty('--amin-tile-unit',Math.max(1,(width-gap*3)/4)+'px');onLayout();});observer.observe(cards);
 window.addEventListener('amin-os:reset-tiles',()=>{clearGesture();layout=defaultTiles();selected=layout[0].id;render();save();});
 window.addEventListener('blur',clearGesture);
 render();
 return {leave(){clearGesture();setEditing(false);}};
}
