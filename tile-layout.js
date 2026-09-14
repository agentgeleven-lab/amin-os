export const TILE_KEY='amin-os.tiles.v2';
export const LEGACY_TILE_KEY='amin-os.tiles.v1';
export const defaultTiles=()=>[
 {id:'map',target:'map',label:'',size:'wide'},{id:'status',target:'status',label:'',size:'medium'},{id:'reply',target:'reply',label:'',size:'medium'},
 {id:'information',target:'information',label:'',size:'wide'},{id:'effects',target:'effects',label:'',size:'wide'},{id:'ai',target:'ai',label:'',size:'small'},{id:'settings',target:'settings',label:'',size:'small'},
];
export function normalizeTiles(value){
 if(!Array.isArray(value))return defaultTiles();
 const known=new Set(defaultTiles().map(t=>t.target)),seen=new Set();
 return value.flatMap(t=>{if(typeof t?.id!=='string'||!t.id||seen.has(t.id)||!known.has(t.target))return [];seen.add(t.id);return [{id:t.id,target:t.target,label:typeof t.label==='string'?t.label.slice(0,60):'',size:['small','medium','wide','tall'].includes(t.size)?t.size:'medium'}];});
}
export function migrateTiles(value){
 const defaults=defaultTiles(),seen=new Set(),result=[];
 for(const t of Array.isArray(value)?value:[]){const d=defaults.find(d=>d.id===t?.id);if(!d||seen.has(t.id))continue;seen.add(t.id);result.push({...d,size:['small','medium','wide','tall'].includes(t.size)?t.size:d.size});}
 return result.concat(defaults.filter(t=>!seen.has(t.id)));
}
export function loadTiles(storage){
 try{const saved=storage.getItem(TILE_KEY);if(saved!==null){const data=JSON.parse(saved);if(data?.version!==2||!Array.isArray(data.tiles))return defaultTiles();return normalizeTiles(data.tiles);}return migrateTiles(JSON.parse(storage.getItem(LEGACY_TILE_KEY)));}catch{return defaultTiles();}
}
export function saveTiles(storage,tiles){storage.setItem(TILE_KEY,JSON.stringify({version:2,tiles:normalizeTiles(tiles)}));}
export function moveTile(tiles,id,target,after=false){
 const list=normalizeTiles(tiles),source=list.find(t=>t.id===id);if(!source||id===target)return list;
 const rest=list.filter(t=>t.id!==id),index=rest.findIndex(t=>t.id===target);if(index<0)return list;rest.splice(index+(after?1:0),0,source);return rest;
}
export function resetTileLayout(){try{saveTiles(localStorage,defaultTiles());}catch{}window.dispatchEvent(new Event('amin-os:reset-tiles'));}
