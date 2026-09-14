import test from 'node:test';
import assert from 'node:assert/strict';
import {createAI,initializeAI} from '../ai/service.js';
import {generateOptions} from '../apps/reply/generator.js';
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),dump:()=>JSON.stringify([...m])};};
const tick=()=>new Promise(r=>setImmediate(r));
const request={systemPrompt:'JSON contract',prompt:'complete context'};
test('all applications share limits, ordered preset, and captured settings',async()=>{
 const ai=createAI(storage(),'snap'),seen=[];
 ai.settings.save({...ai.settings.snapshot(),maxTokens:1234});
 const p=ai.presets.list()[0];p.blocks.unshift({type:'text',enabled:true,role:'system',text:'shared instruction'});ai.presets.save(p);
 const snapshot=ai.capture();ai.settings.save({...ai.settings.snapshot(),maxTokens:2222});
 for(const app of ['地图','世界状态','回复选项'])await ai.generate(app,{generateRaw:async r=>{seen.push(r);return 'ok';}},request,{snapshot});
 assert.equal(seen.length,3);for(const r of seen){assert.equal(r.responseLength,1234);assert.match(r.prompt,/shared instruction/);assert.match(r.prompt,/complete context/);assert.equal(r.systemPrompt,'JSON contract');}
 assert.equal(ai.previews().length,3);
});
test('global FIFO keeps host slot after cancel; cancelled queued task never calls model',async()=>{
 const ai=createAI(storage(),'fifo');let finish;const seen=[];
 const a=ai.generate('map',{generateRaw:()=>{seen.push('a');return new Promise(r=>finish=r);}},request);
 await tick();ai.cancel(ai.tasks()[0].id);await assert.rejects(a);
 const b=ai.generate('status',{generateRaw:async()=>{seen.push('b');return 'b';}},request);
 ai.cancel(ai.tasks()[1].id);await assert.rejects(b);
 const c=ai.generate('reply',{generateRaw:async()=>{seen.push('c');return 'c';}},request);
 await tick();assert.deepEqual(seen,['a']);finish('late');assert.equal(await c,'c');assert.deepEqual(seen,['a','c']);
});
test('session keys are excluded from persistence and previews',async()=>{
 const store=storage(),ai=createAI(store,'secret');
 ai.settings.save({...ai.settings.snapshot(),apiKey:'test-only-secret'});
 ai.profiles.save('p','p',ai.settings.snapshot());
 await ai.generate('map',{generateRaw:async()=> 'ok'},request);
 assert.ok(!store.dump().includes('test-only-secret'));assert.ok(!JSON.stringify(ai.previews()).includes('test-only-secret'));
 assert.equal(createAI(store,'secret').settings.snapshot().apiKey,'');
});
test('reply adapter actually uses global preset and API limit',async()=>{
 const ai=initializeAI(storage(),'reply-route'),seen=[];ai.settings.save({...ai.settings.snapshot(),maxTokens:3456});
 const p=ai.presets.list()[0];p.blocks.unshift({type:'text',enabled:true,role:'user',text:'GLOBAL-MARKER'});ai.presets.save(p);
 const ctx={chat:[{is_user:false,name:'A',mes:'hello'}],characters:[],generateRaw:async r=>{seen.push(r);return JSON.stringify({options:['one','two','three']});}};
 const result=await generateOptions(ctx,{count:3},{world:[]});assert.equal(result.length,3);assert.equal(seen[0].responseLength,3456);assert.match(seen[0].prompt,/GLOBAL-MARKER/);
});
test('independent API uses shared endpoint, key and limits without falling back to host',async()=>{
 const ai=createAI(storage(),'custom'),calls=[],original=globalThis.fetch;
 ai.settings.save({...ai.settings.snapshot(),enabled:true,baseUrl:'https://example.test/v1',model:'test-model',apiKey:'test-key',maxTokens:4567});
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}]})};};
 try {for(const app of ['map','status','reply'])assert.equal(await ai.generate(app,{generateRaw(){throw Error('wrong route');}},request),'ok');}
 finally {globalThis.fetch=original;}
 for(const {url,options}of calls){assert.equal(url,'https://example.test/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-key');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');const body=JSON.parse(options.body);assert.equal(body.max_tokens,4567);assert.equal(body.model,'test-model');assert.equal(body.messages.at(-1).content,'JSON contract');}
});
test('global preset cannot silently omit application request',async()=>{
 const ai=createAI(storage(),'invalid'),snapshot=ai.capture();snapshot.preset.blocks=[];
 await assert.rejects(ai.generate('reply',{generateRaw(){throw Error('must not run');}},request,{snapshot}),/本次要求/);
});
