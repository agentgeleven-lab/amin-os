import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureAudioMessageId,persistAudioMessageId,messageVersion,audioMessageSource} from '../apps/floor-message.js';

test('audio identity save is shared and failed saves remain retryable',async()=>{
 const message={extra:{other:true}},ctx={async saveChat(){calls++;throw Error('save failed');}};let calls=0;
 const results=await Promise.allSettled([persistAudioMessageId(ctx,message),persistAudioMessageId(ctx,message)]);
 assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'));
 assert.equal(message.extra.amin_os_tts_message_id,undefined);assert.equal(message.extra.other,true);
 ctx.saveChat=async()=>{calls++;};await persistAudioMessageId(ctx,message);await persistAudioMessageId(ctx,message);
 assert.equal(calls,2);assert.ok(message.extra.amin_os_tts_message_id);
});

test('audio stays with its message across floor reorder and isolates otherwise identical floors',async()=>{
 const a={name:'角色',mes:'同一句话',swipe_id:0,extra:{other:'keep'}},b=structuredClone(a);
 assert.equal(ensureAudioMessageId(a,()=> 'message-a'),true);
 assert.equal(ensureAudioMessageId(a,()=> 'unwanted'),false);
 ensureAudioMessageId(b,()=> 'message-b');
 const source=await audioMessageSource('chat-a',a);
 assert.equal(await audioMessageSource('chat-a',structuredClone(a)),source);
 assert.notEqual(await audioMessageSource('chat-a',b),source);
 assert.notEqual(await audioMessageSource('chat-b',a),source);
 assert.equal(a.extra.other,'keep');assert.equal(a.mes,'同一句话');
});

test('audio identity changes on same-object swipe or edit and recovers for original content',async()=>{
 const m={name:'角色',mes:'原回复',swipe_id:0,extra:{}};ensureAudioMessageId(m,()=> 'message');
 const before=messageVersion(m),source=await audioMessageSource('chat',m);
 m.swipe_id=1;m.mes='另一候选';assert.notEqual(messageVersion(m),before);assert.notEqual(await audioMessageSource('chat',m),source);
 m.swipe_id=0;m.mes='原回复';assert.equal(await audioMessageSource('chat',m),source);
 m.mes='原回复经编辑';assert.notEqual(await audioMessageSource('chat',m),source);
});

test('audio source is identical when insecure HTTP has no WebCrypto subtle API',async()=>{
 const message={name:'角色',mes:'局域网手机📱',swipe_id:0,extra:{amin_os_tts_message_id:'message'}};
 const regular=await audioMessageSource('chat',message);
 assert.equal(await audioMessageSource('chat',message,{}),regular);
 assert.equal(await audioMessageSource('chat',message,{subtle:{}}),regular);
});
