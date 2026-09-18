import {getAppearance} from './appearance.js';
// UI-only dock: preserve message text, own button visibility and opening order.
const rows=new WeakMap();
export function mountFloorControl(element,id,host,button,document=globalThis.document){
 let row=rows.get(element);
 if(!row){const root=document.createElement('div'),toolbar=document.createElement('div');root.className='amin-floor';toolbar.className='amin-floor-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','楼层应用');root.append(toolbar);(element.querySelector('.mes_block')??element).append(root);row={root,toolbar,items:new Set(),opened:[]};rows.set(element,row);}
 host.dataset.floorApp=id;button.dataset.floorApp=id;row.toolbar.append(button);row.root.append(host);
 const item={id,button,visible:true,open:false,host};row.items.add(item);for(const i of [...row.items].sort((a,b)=>["map","status","reply","effects","information","worldbooks"].indexOf(a.id)-["map","status","reply","effects","information","worldbooks"].indexOf(b.id)))row.toolbar.append(i.button);
 const reorder=()=>{for(const i of [...row.opened,...[...row.items].filter(x=>!x.open)]){if(i.host.style)i.host.style.order=String(i.open?row.opened.indexOf(i)+1:row.items.size+1);row.root.append(i.host);}};
 function setOpen(value){if(value===item.open)return;item.open=value;row.opened=row.opened.filter(x=>x!==item);if(value)row.opened.push(item);reorder();}
 const reflect=()=>{
  const visible=item.visible&&(getAppearance()?.snapshot().floor.buttons?.[id]!==false);
  if(!visible&&item.open){button.click?.();setOpen(false);}
  item.shown=visible;host.hidden=!visible;button.hidden=!visible;row.root.hidden=![...row.items].some(x=>x.shown??x.visible);
 };
 const off=getAppearance()?.subscribe(reflect);reflect();
 return {setOpen,setVisible(value){item.visible=value;reflect();},dispose(){off?.();setOpen(false);host.remove();button.remove();row.items.delete(item);if(!row.items.size){row.root.remove();rows.delete(element);}else {reorder();row.root.hidden=![...row.items].some(x=>x.shown??x.visible);}}};
}
