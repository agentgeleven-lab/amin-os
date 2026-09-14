// Shared UI container only; never move message text or change stored chat.
const rows=new WeakMap();
export function mountFloorControl(element,id,host,button,document=globalThis.document){
 let row=rows.get(element);
 if(!row){const root=document.createElement('div'),toolbar=document.createElement('div');root.className='amin-floor';toolbar.className='amin-floor-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','楼层应用');root.append(toolbar);(element.querySelector('.mes_block')??element).append(root);row={root,toolbar,items:new Set()};rows.set(element,row);}
 host.dataset.floorApp=id;button.dataset.floorApp=id;row.toolbar.append(button);row.root.append(host);
 const item={visible:true};row.items.add(item);
 const reflect=()=>{row.root.hidden=![...row.items].some(x=>x.visible);};
 return {setVisible(value){item.visible=value;host.hidden=!value;button.hidden=!value;reflect();},dispose(){host.remove();button.remove();row.items.delete(item);if(!row.items.size){row.root.remove();rows.delete(element);}else reflect();}};
}
