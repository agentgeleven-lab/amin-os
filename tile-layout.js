export const TILE_KEY='amin-os.tiles.v1';
export const defaultTiles=()=>[
 {id:'map',size:'wide'},{id:'status',size:'medium'},{id:'reply',size:'medium'},
 {id:'ai',size:'small'},{id:'settings',size:'small'},
];
export function normalizeTiles(value){
 const defaults=defaultTiles(),known=new Map(defaults.map(t=>[t.id,t])),seen=new Set(),result=[];
 for(const tile of Array.isArray(value)?value:[]){
  if(!known.has(tile?.id)||seen.has(tile.id))continue;
  seen.add(tile.id);result.push({id:tile.id,size:['small','medium','wide'].includes(tile.size)?tile.size:known.get(tile.id).size});
 }
 return result.concat(defaults.filter(t=>!seen.has(t.id)));
}
export function moveTile(tiles,id,target,after=false){
 const list=normalizeTiles(tiles),source=list.find(t=>t.id===id);
 if(!source||id===target)return list;
 const rest=list.filter(t=>t.id!==id),index=rest.findIndex(t=>t.id===target);
 if(index<0)return list;
 rest.splice(index+(after?1:0),0,source);return rest;
}
export function resetTileLayout(){
 try{localStorage.setItem(TILE_KEY,JSON.stringify(defaultTiles()));}catch{}
 window.dispatchEvent(new Event('amin-os:reset-tiles'));
}
