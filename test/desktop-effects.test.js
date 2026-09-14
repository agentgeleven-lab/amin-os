import test from 'node:test';
import assert from 'node:assert/strict';
import {effectsDefaults,validateEffects,mediaURL} from '../desktop-effects-model.js';
import {normalizeTiles,moveTile} from '../tile-layout.js';
import {defaults,validate} from '../settings/appearance.js';
test('effects migrate disabled and reject invalid media and animation limits',()=>{
 assert.deepEqual(validateEffects(),effectsDefaults());assert.equal(validate(defaults()).desktop.effects.effect,'none');
 for(const url of ['javascript:alert(1)','file:///c:/x','data:image/svg+xml,test','https://user:key@example.com'])assert.throws(()=>mediaURL(url));
 assert.equal(mediaURL('/assets/a.png'),'/assets/a.png');assert.throws(()=>validateEffects({amount:100}));assert.throws(()=>validateEffects({speed:0}));
});
test('individual backgrounds survive normalization, duplication and ordering without retaining bad URLs',()=>{
 const tiles=[{id:'a',target:'map',label:'A',size:'tall',image:'https://example.com/a.png'},{id:'b',target:'map',label:'B',size:'small',image:'/assets/b.png'}];
 assert.deepEqual(normalizeTiles(tiles),tiles);assert.equal(moveTile(tiles,'b','a')[0].image,'/assets/b.png');assert.equal(normalizeTiles([{...tiles[0],image:'javascript:bad'}])[0].image,undefined);
});
