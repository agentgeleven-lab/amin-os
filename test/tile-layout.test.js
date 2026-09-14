import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTiles,normalizeTiles,moveTile} from '../tile-layout.js';
test('corrupt or old layouts retain every application exactly once',()=>{
 assert.deepEqual(normalizeTiles(null),defaultTiles());
 const normalized=normalizeTiles([{id:'reply',size:'wide'},{id:'reply',size:'small'},{id:'map',size:'huge'},{id:'unknown',size:'wide'},null]);
 assert.deepEqual(normalized.map(t=>t.id),['reply','map','status','information','effects','ai','settings']);
 assert.equal(normalized[0].size,'wide');assert.equal(normalized[1].size,'wide');
});
test('drag moves before or after target, keeping sizes and source immutable',()=>{
 const start=defaultTiles(),moved=moveTile(start,'settings','map');
 assert.equal(moved[0].id,'settings');assert.equal(moved[0].size,'small');
 assert.deepEqual(moveTile(moved,'settings','ai',true),start);
 assert.deepEqual(start,defaultTiles());assert.deepEqual(moveTile(start,'map','map'),start);
 assert.deepEqual(moveTile(start,'map','missing'),start);
});
test('saved layout round trips including all three tile sizes',()=>{
 const custom=moveTile(defaultTiles(),'ai','map');custom[0].size='wide';
 assert.deepEqual(normalizeTiles(JSON.parse(JSON.stringify(custom))),custom);
});
