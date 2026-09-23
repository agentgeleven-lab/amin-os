import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTiles,normalizeTiles,moveTile,migrateTiles,loadTiles,saveTiles,TILE_KEY,LEGACY_TILE_KEY,PREVIOUS_TILE_KEY,TILE_COLUMNS,TILE_SPANS,moveTileToCell,canPlaceTile} from '../tile-layout.js';
test('release applications appear once while later user removals remain removed',()=>{
 const data=new Map([[TILE_KEY,JSON.stringify({version:2,tiles:[{id:'mine',target:'map',label:'我的地图',size:'wide'}]})]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const migrated=loadTiles(storage);assert.deepEqual(migrated.map(t=>t.target),['map','characters','inventory','relationships','saves']);assert.equal(migrated[0].label,'我的地图');
 assert.deepEqual(loadTiles(storage),migrated);saveTiles(storage,migrated.filter(t=>t.target!=='saves'));assert.equal(loadTiles(storage).some(t=>t.target==='saves'),false);
});
test('corrupt or old layouts retain every application exactly once',()=>{
 assert.deepEqual(normalizeTiles(null),defaultTiles());
 const normalized=migrateTiles([{id:'reply',size:'wide'},{id:'reply',size:'small'},{id:'map',size:'huge'},{id:'unknown',size:'wide'},null]);
 assert.deepEqual(normalized.map(t=>t.id),['reply','map','characters','inventory','relationships','saves','scene','journal','dice','status','organizations','information','effects','worldbooks','tts','ai','settings']);
 assert.equal(normalized[0].size,'wide');assert.equal(normalized[1].size,'wide');
});
test('drag moves before or after target, keeping sizes and source immutable',()=>{
 const start=defaultTiles(),moved=moveTile(start,'settings','map');
 assert.equal(moved.findIndex(t=>t.id==='settings')+1,moved.findIndex(t=>t.id==='map'));assert.equal(moved.find(t=>t.id==='settings').size,'small');
 assert.deepEqual(moveTile(moved,'settings','ai',true),start);
 assert.deepEqual(start,defaultTiles());assert.deepEqual(moveTile(start,'map','map'),start);
 assert.deepEqual(moveTile(start,'map','missing'),start);
});
test('saved layout round trips including all three tile sizes',()=>{
 const custom=moveTile(defaultTiles(),'ai','map');custom[0].label='自定义';
 assert.deepEqual(normalizeTiles(JSON.parse(JSON.stringify(custom))),custom);
});

test('custom tile identities allow repeated targets without forcing missing apps back',()=>{
 const tiles=[{id:'one',target:'map',label:'旅行地图',size:'wide'},{id:'two',target:'map',label:'地点',size:'small'}];
 assert.deepEqual(normalizeTiles(normalizeTiles(tiles)),normalizeTiles(tiles));assert.deepEqual(normalizeTiles([]),[]);
 const moved=moveTile(tiles,'two','one');assert.deepEqual(moved.map(t=>t.id),['two','one']);assert.equal(moved[0].target,'map');assert.equal(tiles[0].id,'one');
 const corrupted=normalizeTiles([...tiles,{...tiles[0],target:'reply'},{id:'bad',target:'missing'},null]);assert.deepEqual(corrupted,normalizeTiles(tiles));
});
test('storage migration preserves legacy order and customized layouts survive reload and empty state',()=>{
 const data=new Map([[LEGACY_TILE_KEY,JSON.stringify([{id:'reply',size:'wide'},{id:'map',size:'small'}])]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const legacy=loadTiles(storage);assert.equal(legacy[0].target,'reply');assert.equal(legacy[1].size,'small');
 const custom=[{...legacy[0],id:'custom',target:'information',label:'人物档案'}];saveTiles(storage,custom);assert.deepEqual(loadTiles(storage),custom);
 saveTiles(storage,[]);assert.deepEqual(loadTiles(storage),[]);assert.ok(data.has(LEGACY_TILE_KEY));
 data.set(TILE_KEY,'broken');assert.deepEqual(loadTiles(storage),legacy);
});

test('portrait tiles retain footprint through persistence, copies and reordering',()=>{
 const layout=[{id:'long',target:'map',label:'竖向地图',size:'tall'},...defaultTiles()];
 assert.equal(normalizeTiles(layout)[0].size,'tall');assert.equal(moveTile(layout,'long','settings',true).at(-1).size,'tall');
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};saveTiles(storage,layout);assert.deepEqual(loadTiles(storage),normalizeTiles(layout));
});


test('merged writing app has one default tile but preserves old rewrite aliases and labels',()=>{
 assert.equal(defaultTiles().some(t=>t.target==='stylewriter'),false);
 const old=[{id:'my-rewrite',target:'stylewriter',label:'我的润色',size:'tall'}];
 assert.deepEqual(normalizeTiles(normalizeTiles(old)),normalizeTiles(old));
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 saveTiles(storage,old);assert.deepEqual(loadTiles(storage),normalizeTiles(old));
 const migrated=migrateTiles([{id:'stylewriter',size:'wide'}]);
 assert.equal(migrated[0].target,'stylewriter');assert.equal(migrated[0].size,'wide');
});


test('fine grid spans include both short rectangles and preserve exact top-left destinations',()=>{
 assert.equal(TILE_COLUMNS,6);assert.deepEqual(TILE_SPANS.compactWide,{w:3,h:2});assert.deepEqual(TILE_SPANS.compactTall,{w:2,h:3});
 const start=normalizeTiles([{id:'a',target:'map',size:'compactWide',x:0,y:0},{id:'b',target:'dice',size:'compactTall',x:4,y:0}]);
 const result=moveTileToCell(start,'a',1,5);assert.equal(result.success,true);assert.deepEqual(result.tiles[0],{...start[0],x:1,y:5});assert.deepEqual(result.tiles[1],start[1]);assert.equal(start[0].x,0);
 const storageData=new Map(),storage={getItem:k=>storageData.get(k)??null,setItem:(k,v)=>storageData.set(k,v)};
 saveTiles(storage,result.tiles);assert.deepEqual(loadTiles(storage),result.tiles);
});
test('blocked or out-of-grid drops leave every tile at its original position',()=>{
 const start=normalizeTiles([{id:'a',target:'map',size:'medium',x:0,y:0},{id:'b',target:'dice',size:'small',x:3,y:1}]);
 for(const [x,y,reason] of [[2,0,'occupied'],[5,0,'bounds'],[-1,0,'bounds'],[0,255,'bounds'],[0.5,0,'bounds'],[0,NaN,'bounds']]){const result=moveTileToCell(start,'a',x,y);assert.equal(result.success,false);assert.equal(result.reason,reason);assert.deepEqual(result.tiles,start);}
 assert.equal(canPlaceTile(start,'a',0,0),true);assert.equal(moveTileToCell(start,'a',0,0).success,true);
 assert.equal(moveTileToCell(start,'missing',0,0).reason,'missing');
});
test('packing reserves explicit coordinates and deterministically repairs overlaps without filling intentional gaps',()=>{
 const input=[{id:'new',target:'map',size:'medium'},{id:'fixed',target:'dice',size:'wide',x:0,y:0},{id:'overlap',target:'reply',size:'medium',x:1,y:0},{id:'far',target:'scene',size:'small',x:5,y:20}];
 const layout=normalizeTiles(input);assert.deepEqual([layout[1].x,layout[1].y],[0,0]);assert.deepEqual([layout[0].x,layout[0].y],[4,0]);assert.deepEqual([layout[3].x,layout[3].y],[5,20]);
 assert.deepEqual(normalizeTiles(layout),layout);for(const tile of layout)assert.equal(canPlaceTile(layout,tile.id,tile.x,tile.y),true);
});
test('version2 migrates custom identities images colors and order without changing old storage',()=>{
 const tiles=[{id:'mine',target:'stylewriter',label:'自定义',size:'wide',image:'https://example.com/pic.png',backgroundColor:'#12abEF',textColor:'#ffffff',iconColor:'#ffeedd'},{id:'other',target:'dice',size:'compactTall',backgroundColor:'red',textColor:'url(bad)',iconColor:'#abc'}];
 const old=JSON.stringify({version:2,knownTargets:defaultTiles().map(t=>t.target),tiles});const data=new Map([[PREVIOUS_TILE_KEY,old]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const layout=loadTiles(storage);assert.deepEqual(layout.map(t=>t.id),['mine','other']);assert.equal(layout[0].backgroundColor,'#12abEF');assert.equal(layout[0].image,tiles[0].image);assert.equal(layout[1].backgroundColor,undefined);assert.equal(layout[1].textColor,undefined);assert.equal(layout[1].iconColor,undefined);assert.equal(data.get(PREVIOUS_TILE_KEY),old);assert.equal(JSON.parse(data.get(TILE_KEY)).version,3);assert.deepEqual(loadTiles(storage),layout);
 data.set(TILE_KEY,'broken');assert.deepEqual(loadTiles(storage),layout);
});
