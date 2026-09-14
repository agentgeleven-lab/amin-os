import test from 'node:test';
import assert from 'node:assert/strict';
import {floorContext} from '../apps/reply/floor-ui.js';
test('floor generation excludes later messages without mutating live chat',()=>{
 const messages=[{mes:'first'},{mes:'second'},{mes:'future'}],ctx={chat:messages,extensionSettings:{keep:1}};
 const scoped=floorContext(ctx,1,messages[1]);
 assert.deepEqual(scoped.chat,messages.slice(0,2));assert.equal(ctx.chat.length,3);
 assert.equal(scoped.extensionSettings,ctx.extensionSettings);
 scoped.chat.pop();assert.equal(ctx.chat.length,3);
});
test('recycled, deleted or invalid floors cannot generate against the wrong message',()=>{
 const old={mes:'old'},ctx={chat:[{mes:'new'}]};
 assert.throws(()=>floorContext(ctx,0,old));assert.throws(()=>floorContext(ctx,-1,old));assert.throws(()=>floorContext(ctx,1.5,old));
});
