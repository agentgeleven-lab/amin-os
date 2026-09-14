import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveHostConnection} from '../ai/host-connection.js';
import {createAI} from '../ai/service.js';
const config={enabled:false,apiKey:'unrelated-manual-secret'};
const settings={chat_completion_source:'custom',custom_url:'https://model.test/v1',custom_model:'example'};
const secrets={SECRET_KEYS:{CUSTOM:'custom',OPENAI:'openai',OPENROUTER:'router'},secret_state:{custom:[{active:true}]},canViewSecrets:async()=>true,findSecret:async key=>`${key}-secret`};
const load=(s=settings,keys=secrets)=>async()=>({mainApi:'openai',settings:s,secrets:keys});
test('inherits custom destination/model and only its active secret',async()=>{
 const c=await resolveHostConnection(config,{load:load()});
 assert.equal(c.enabled,true);assert.equal(c.baseUrl,settings.custom_url);assert.equal(c.model,'example');assert.equal(c.apiKey,'custom-secret');assert.equal(c.rememberKey,false);
});
test('unreadable key fails explicitly and never uses a manual key',async()=>{
 await assert.rejects(resolveHostConnection(config,{load:load(settings,{...secrets,canViewSecrets:async()=>false,findSecret(){throw Error('must not read');}})}),/未允许读取/);
});
test('custom endpoint without a configured key can run without authorization',async()=>{
 const c=await resolveHostConnection(config,{load:load(settings,{...secrets,secret_state:{custom:[]},canViewSecrets:async()=>false})});assert.equal(c.apiKey,'');
});
test('reverse proxy only receives its proxy password, never official key',async()=>{
 const c=await resolveHostConnection(config,{load:load({chat_completion_source:'openai',openai_model:'model',reverse_proxy:'https://proxy.test/v1',proxy_password:'proxy-key'},{...secrets,findSecret(){throw Error('must not read official key');}})});
 assert.equal(c.apiKey,'proxy-key');assert.equal(c.baseUrl,'https://proxy.test/v1');
});
test('unsupported provider and custom request overrides are rejected explicitly',async()=>{
 await assert.rejects(resolveHostConnection(config,{load:load({chat_completion_source:'claude'})}),/暂不支持/);
 await assert.rejects(resolveHostConnection(config,{load:load({...settings,custom_include_headers:'special: value'})}),/额外请求体或请求头/);
 await assert.rejects(resolveHostConnection(config,{load:async()=>({mainApi:'textgenerationwebui'})}),/不是 Chat Completions/);
});
test('shared inherited route calls remote fetch; host generation is never invoked',async()=>{
 const m=new Map(),calls=[];let reads=0;
 const ai=createAI({getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)},'direct',{
  resolveConnection:c=>{reads++;return resolveHostConnection(c,{load:load()});},
  fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({choices:[{message:{content:'done'}}]})};}
 });
 const ctx={generateRaw(){throw Error('host generation is forbidden');}},snapshot=ai.capture();
 for(const app of ['信息面板','能力面板','地图','世界状态','回复选项'])assert.equal(await ai.generate(app,ctx,{systemPrompt:'contract',prompt:'data'},{snapshot}),'done');
 assert.equal(reads,1);assert.equal(calls.length,5);
 for(const {url,options} of calls){assert.equal(url,'https://model.test/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer custom-secret');assert.equal(options.credentials,'omit');}
 assert.ok(!JSON.stringify([...m]).includes('custom-secret'));assert.ok(!JSON.stringify(snapshot).includes('custom-secret'));assert.ok(!JSON.stringify(ai.previews()).includes('custom-secret'));
});
test('cancel propagates to independent fetch and settles the task',async()=>{
 const m=new Map();let requestSignal;
 const ai=createAI({getItem:k=>m.get(k),setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)},'abort',{
  resolveConnection:c=>resolveHostConnection(c,{load:load()}),
  fetchImpl:(_url,options)=>new Promise((_resolve,reject)=>{requestSignal=options.signal;options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})
 });
 const pending=ai.generate('信息面板',{}, {systemPrompt:'contract',prompt:'data'});
 await new Promise(r=>setImmediate(r));ai.cancel(ai.tasks()[0].id);
 await assert.rejects(pending);assert.equal(requestSignal.aborted,true);assert.equal(ai.tasks()[0].state,'已取消');
});
