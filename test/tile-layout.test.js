import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTiles,normalizeTiles,moveTile,migrateTiles,loadTiles,saveTiles,TILE_KEY,LEGACY_TILE_KEY} from '../tile-layout.js';
test('corrupt or old layouts retain every application exactly once',()=>{
 assert.deepEqual(normalizeTiles(null),defaultTiles());
 const normalized=migrateTiles([{id:'reply',size:'wide'},{id:'reply',size:'small'},{id:'map',size:'huge'},{id:'unknown',size:'wide'},null]);
 assert.deepEqual(normalized.map(t=>t.id),['reply','map','scene','journal','dice','status','organizations','information','effects','worldbooks','tts','ai','settings']);
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
 const custom=moveTile(defaultTiles(),'ai','map');custom[0].size='wide';
 assert.deepEqual(normalizeTiles(JSON.parse(JSON.stringify(custom))),custom);
});

test('custom tile identities allow repeated targets without forcing missing apps back',()=>{
 const tiles=[{id:'one',target:'map',label:'旅行地图',size:'wide'},{id:'two',target:'map',label:'地点',size:'small'}];
 assert.deepEqual(normalizeTiles(tiles),tiles);assert.deepEqual(normalizeTiles([]),[]);
 const moved=moveTile(tiles,'two','one');assert.deepEqual(moved.map(t=>t.id),['two','one']);assert.equal(moved[0].target,'map');assert.equal(tiles[0].id,'one');
 const corrupted=normalizeTiles([...tiles,{...tiles[0],target:'reply'},{id:'bad',target:'missing'},null]);assert.deepEqual(corrupted,tiles);
});
test('storage migration preserves legacy order and customized layouts survive reload and empty state',()=>{
 const data=new Map([[LEGACY_TILE_KEY,JSON.stringify([{id:'reply',size:'wide'},{id:'map',size:'small'}])]]),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const legacy=loadTiles(storage);assert.equal(legacy[0].target,'reply');assert.equal(legacy[1].size,'small');
 const custom=[{...legacy[0],id:'custom',target:'information',label:'人物档案'}];saveTiles(storage,custom);assert.deepEqual(loadTiles(storage),custom);
 saveTiles(storage,[]);assert.deepEqual(loadTiles(storage),[]);assert.ok(data.has(LEGACY_TILE_KEY));
 data.set(TILE_KEY,'broken');assert.deepEqual(loadTiles(storage),defaultTiles());
});

test('portrait tiles retain footprint through persistence, copies and reordering',()=>{
 const layout=[{id:'long',target:'map',label:'竖向地图',size:'tall'},...defaultTiles()];
 assert.equal(normalizeTiles(layout)[0].size,'tall');assert.equal(moveTile(layout,'long','settings',true).at(-1).size,'tall');
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};saveTiles(storage,layout);assert.deepEqual(loadTiles(storage),layout);
});


test('merged writing app has one default tile but preserves old rewrite aliases and labels',()=>{
 assert.equal(defaultTiles().some(t=>t.target==='stylewriter'),false);
 const old=[{id:'my-rewrite',target:'stylewriter',label:'我的润色',size:'tall'}];
 assert.deepEqual(normalizeTiles(old),old);
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 saveTiles(storage,old);assert.deepEqual(loadTiles(storage),old);
 const migrated=migrateTiles([{id:'stylewriter',size:'wide'}]);
 assert.equal(migrated[0].target,'stylewriter');assert.equal(migrated[0].size,'wide');
});
