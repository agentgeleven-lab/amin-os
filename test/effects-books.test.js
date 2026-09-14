import test from 'node:test';
import assert from 'node:assert/strict';
import {bookCatalog,readBook} from '../apps/effects/books.js';
test('catalog includes enabled global books without reading contents, deduplicates bindings',()=>{
 const ctx={characterId:0,characters:[{data:{extensions:{world:'shared'}}}],loadWorldInfo(){throw Error('must not read');}};
 const result=bookCatalog(ctx,{world_info:{globalSelect:['global','shared']},world_names:['disabled']});
 assert.deepEqual(result.map(b=>b.name),['global','shared']);assert.deepEqual(result[1].sources,['全局启用','角色绑定']);
});
test('only selected book is read and original contents remain unchanged',async()=>{
 const source={entries:{1:{content:'skill'},2:{content:'off',disable:true},3:{content:''}}},before=JSON.stringify(source),calls=[];
 const ctx={loadWorldInfo:async name=>{calls.push(name);return source;}};
 const books=bookCatalog(ctx,{selected_world_info:['one','two']});
 const entries=await readBook(ctx,books[1]);assert.deepEqual(calls,['two']);assert.equal(entries.length,1);assert.equal(entries[0].book,'two');assert.equal(JSON.stringify(source),before);
});
