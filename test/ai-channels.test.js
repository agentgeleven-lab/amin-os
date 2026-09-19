import test from 'node:test';
import assert from 'node:assert/strict';
import {createAI,AI_APPS} from '../ai/service.js';
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),m};};
const request={systemPrompt:'protocol',prompt:'context'};
function setup(){
 const store=storage(),sent=[],ai=createAI(store,'channels',{resolveConnection:async c=>c,fetchImpl:async(url,init)=>{sent.push({url,headers:init.headers,body:JSON.parse(init.body)});return Response.json({choices:[{message:{content:'ok'}}]});}});
 ai.settings.save({...ai.settings.snapshot(),enabled:true,baseUrl:'https://global.test/v1',model:'global',stream:false,queueMode:'parallel'});
 for(const [id,tokens] of [['a',1024],['b',2048]])ai.profiles.save(id,id.toUpperCase(),{...ai.settings.snapshot(),baseUrl:'https://'+id+'.test/v1',model:id,apiKey:'session-'+id,maxTokens:tokens,requestBody:JSON.stringify({temperature:id==='a'?0.2:0.8})});
 return {store,ai,sent};
}
test('each AI app resolves its saved channel and independent request body while unbound apps follow global',async()=>{
 const {ai,sent}=setup();ai.setChannel('map','a');ai.setChannel('information','b');
 for(const name of ['地图','世界状态','信息面板','信息面板 · 模拟推演'])await ai.generate(name,{},request);
 assert.deepEqual(sent.map(x=>x.body.model),['a','global','b','b']);
 assert.match(sent[0].url,/a.test/);assert.equal(sent[0].body.temperature,.2);assert.equal(sent[0].body.max_tokens,1024);assert.equal(sent[2].body.temperature,.8);
 assert.equal(sent[0].headers.Authorization,'Bearer session-a');assert.equal(ai.settings.snapshot().model,'global');
 assert.equal(ai.tasks()[0].channel,'A');
});
test('app bindings persist, route all task names, validate selection, and deletion returns to global',()=>{
 const {ai,store}=setup();for(const app of AI_APPS){ai.setChannel(app.id,'a');for(const task of app.tasks)assert.equal(ai.capture(task).config.model,'a');}
 const reloaded=createAI(store,'channels');for(const app of AI_APPS)assert.equal(reloaded.channel(app.id),'a');
 assert.throws(()=>ai.setChannel('map','missing'),/不存在/);assert.throws(()=>ai.setChannel('unknown','a'),/未知/);
 assert.ok(!JSON.stringify([...store.m]).includes('session-a'));
 ai.profiles.remove('a');for(const app of AI_APPS){assert.equal(ai.channel(app.id),'');assert.equal(ai.capture(app.id).config.model,'global');}
});
test('captured multi-step jobs retain channel and parameters after rebinding or editing a profile',async()=>{
 const {ai,sent}=setup();ai.setChannel('information','a');const snapshot=ai.capture('information');
 ai.setChannel('information','b');ai.profiles.save('a','edited',{...ai.profiles.get('a'),model:'edited'});
 await ai.generate('信息面板',{},request,{snapshot});await ai.generate('信息面板',{},request,{snapshot});await ai.generate('信息面板',{},request);
 assert.deepEqual(sent.map(x=>x.body.model),['a','a','b']);
 ai.setChannel('information','');assert.equal(ai.capture('information').config.model,'global');
});
