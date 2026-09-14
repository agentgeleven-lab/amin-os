import test from 'node:test';
import assert from 'node:assert/strict';
import {empty,apply,current,compile,KEY} from '../apps/information/model.js';
import {createInformation,PROMPT_KEY} from '../apps/information/service.js';
import {parseFields,generateRecord,simulate} from '../apps/information/generator.js';
import {retrieve,webSearch,searchEndpoint,localSources} from '../apps/information/sources.js';
const chat=[{name:'a',mes:'hello',is_user:true}];
const record=()=>({id:'r',name:'甲',kind:'person',mode:'retcon',fields:[{id:'f',category:'身份',label:'职业',value:'守卫',status:'known',sources:[]}]});
test('drafts do not mutate committed state, application diffs delete old facts, rollback is a new version',()=>{
 const s=empty(),r=record(),one=apply(s,chat,r);assert.equal(s.history.length,0);
 r.fields[0].value='名医';const two=apply(one,chat,r);assert.equal(current(one,chat)[0].fields[0].value,'守卫');assert.match(compile(two,chat),/名医/);
 r.fields=[];const three=apply(two,chat,r);assert.match(compile(three,chat),/已删除字段/);assert.equal(current(three,chat)[0].removed[0].label,'职业');
 const rollback=apply(three,chat,one.history[0].snapshot,'回滚');assert.equal(rollback.history.length,4);assert.equal(current(rollback,chat)[0].removed.length,0);assert.match(compile(rollback,chat),/守卫/);
});
test('branch evidence excludes deleted, edited or swiped future settings across reload',()=>{
 const s=JSON.parse(JSON.stringify(apply(empty(),chat,record())));
 assert.equal(current(s,[]).length,0);assert.equal(current(s,[{...chat[0],swipe_id:1}]).length,0);assert.equal(current(s,[{...chat[0],mes:'changed'}]).length,0);assert.equal(current(s,[...chat,{mes:'next'}]).length,1);
});
test('facts require verifiable source quotes; creation requires opt-in',()=>{
 const sources=[{id:'x',title:'原文',text:'甲是守卫。'}];const text=JSON.stringify({fields:[{category:'身份',label:'职业',value:'守卫',status:'known',sources:[{id:'x',quote:'甲是守卫'}]},{category:'能力',label:'天赋',value:'预知',status:'invented'},{category:'年龄',label:'年龄',value:'20',status:'known',sources:[{id:'fake',quote:'20'}]}]});
 const fields=parseFields(text,sources,false);assert.deepEqual(fields.map(f=>f.status),['known','unknown','unknown']);assert.equal(parseFields(text,sources,true)[1].status,'invented');
 const r=record();r.fields=fields;const prompt=compile(apply(empty(),chat,r),chat);assert.doesNotMatch(prompt,/预知|"年龄"/);
});
test('retrieval chunks have unique IDs and explicitly reports budget omissions',()=>{
 const docs=[{id:'a',title:'甲',text:'a'.repeat(5000)},{id:'b',title:'甲',text:'b'.repeat(12000)}];const all=retrieve(docs,['甲'],{limit:40000});assert.equal(new Set(all.sources.map(s=>s.id)).size,all.sources.length);assert.equal(all.sources.filter(s=>s.id.startsWith('a:')).length,1);
 const limited=retrieve(docs,['甲'],{limit:5000});assert.ok(limited.report.omitted>0);assert.ok(limited.report.characters<=5000);
});
test('web search keeps secrets in request headers, omits credentials and rejects bad endpoints',async()=>{
 assert.throws(()=>searchEndpoint('javascript:alert(1)'),/搜索地址/);assert.throws(()=>searchEndpoint('https://user:pass@example.com/search'),/搜索地址/);
 let received;const result=await webSearch({query:'甲',key:'secret',fetcher:async(url,options)=>{received={url,options};return {ok:true,json:async()=>({results:[{title:'网页',content:'甲是守卫',url:'https://example.test/page'},{content:'bad',url:'javascript:alert(1)'}]})};}});
 assert.equal(received.options.credentials,'omit');assert.equal(received.options.redirect,'error');assert.equal(received.options.headers.Authorization,'Bearer secret');assert.doesNotMatch(received.options.body,/secret/);assert.equal(result[1].url,'');
 await assert.rejects(webSearch({query:'x',key:'secret',fetcher:async()=>({ok:false,status:401})}),/401/);
});
test('AI retrieval pipeline passes only retrieved sources, preserves manual facts, and cannot save',async()=>{
 const ctx={chatMetadata:{}},seen=[],old=record();old.fields[0].value='用户改写';old.fields[0].status='edited';
 const ai={capture:()=>({}),generate:async(...args)=>{seen.push(args);return seen.length===1?'{"queries":["甲"]}':JSON.stringify({fields:[{category:'身份',label:'职业',value:'守卫',status:'known',sources:[{id:'x:0',quote:'甲是守卫'}]}]});}};
 const result=await generateRecord({ai,ctx,existing:old,options:{name:'甲',kind:'person',scope:'web',webKey:'secret',allowInvent:false,sourceLimit:90000},searchWeb:async()=>[{id:'x',title:'甲',text:'甲是守卫'}],loadLocal:()=>{throw Error('must not read local');}});
 assert.equal(result.record.fields[0].value,'用户改写');assert.equal(JSON.stringify(ctx),' {"chatMetadata":{}}'.trim());assert.doesNotMatch(JSON.stringify(seen),/secret/);assert.equal(seen[1][3].includeEffects,false);
});
test('cancelled generation and simulation never return a late result',async()=>{
 const abort=new AbortController();const ai={capture:()=>({}),generate:async()=>{abort.abort();return '{"queries":[]}';}};
 await assert.rejects(generateRecord({ai,ctx:{},signal:abort.signal,options:{name:'x',scope:'local'}}),/取消/);
 const ctx={chatMetadata:{}},r=record();ai.generate=async()=>'{"summary":"模拟","proposals":[]}';await simulate({ai,ctx,before:r,draft:r});assert.equal(ctx.chatMetadata[KEY],undefined);
});
test('save rollback, stale form rejection and host prompt clearing are isolated',async()=>{
 const handlers={},prompts=new Map();let ctx={chatMetadata:{},chat:structuredClone(chat),getCurrentChatId:()=> 'a',saveMetadata:async()=>{},setExtensionPrompt:(key,value)=>prompts.set(key,value),eventTypes:{GENERATION_AFTER_COMMANDS:'start',CHAT_CHANGED:'chat',GENERATION_ENDED:'end'},eventSource:{on:(key,fn)=>handlers[key]=fn,removeListener(){}}};
 const api=createInformation(()=>ctx),t=api.capture();await api.save(t,s=>apply(s,ctx.chat,record()));await assert.rejects(api.save(t,s=>s),/变化/);
 handlers.start('normal');assert.match(prompts.get(PROMPT_KEY),/守卫/);handlers.end();assert.equal(prompts.get(PROMPT_KEY),'');
 const before=JSON.stringify(ctx.chatMetadata),fresh=api.capture();ctx.saveMetadata=async()=>{throw Error('disk');};await assert.rejects(api.save(fresh,s=>({...s,enabled:false})),/disk/);assert.equal(JSON.stringify(ctx.chatMetadata),before);
 ctx={...ctx,chatMetadata:{},getCurrentChatId:()=> 'b'};handlers.chat();handlers.start('normal');assert.equal(prompts.get(PROMPT_KEY),'');api.dispose();
});

test('regeneration cannot restore deliberately deleted fields from old sources',async()=>{
 const existing=record();existing.fields=[];existing.removed=[{category:'身份',label:'职业'}];let calls=0;
 const ai={capture:()=>({}),generate:async()=>++calls===1?'{"queries":["甲"]}':JSON.stringify({fields:[{category:'身份',label:'职业',value:'守卫',status:'known',sources:[{id:'x:0',quote:'甲是守卫'}]}]})};
 const result=await generateRecord({ai,ctx:{},existing,options:{name:'甲',kind:'person',scope:'local',sourceLimit:90000},loadLocal:async()=>[{id:'x',title:'甲',text:'甲是守卫'}]});
 assert.deepEqual(result.record.fields,[]);assert.deepEqual(result.record.removed,existing.removed);
});

test('reading a character includes bound and extra books but not unselected globals, with deduplication',async()=>{
 const reads=[];const ctx={characterId:0,characters:[{name:'甲',avatar:'a.png',data:{description:'甲',extensions:{world:'主书'}}}],worldInfoSettings:{world_info:{globalSelect:['全局'],charLore:[{name:'a',extraBooks:['附书']}]}},loadWorldInfo:async name=>{reads.push(name);return {entries:{0:{content:name},1:{content:'停用',disable:true}}};}};
 const docs=await localSources(ctx,{books:['主书'],includeChat:false});assert.deepEqual(reads,['主书','附书']);assert.equal(docs.length,3);assert.ok(docs.some(d=>d.text==='附书'));assert.ok(!docs.some(d=>d.text==='停用'));
 reads.length=0;await localSources(ctx,{includeCard:false,includeChat:false});assert.deepEqual(reads,[]);
 await localSources(ctx,{books:['全局'],includeCard:false,includeChat:false});assert.deepEqual(reads,['全局']);
});
test('group cards include each member book and embedded fallback without reading unrelated cards',async()=>{
 const reads=[];const ctx={groupId:'g',groups:[{id:'g',members:['a.png','b.png']}],characters:[{name:'甲',avatar:'a.png',data:{extensions:{world:'主书'}}},{name:'乙',avatar:'b.png',data:{character_book:{entries:[{content:'乙的内嵌设定',enabled:true},{content:'不可读取',enabled:false}]}}},{name:'丙',avatar:'c.png',data:{extensions:{world:'无关'}}}],worldInfoSettings:{},loadWorldInfo:async name=>{reads.push(name);return {entries:{0:{content:'甲的设定'}}};}};
 const docs=await localSources(ctx,{includeChat:false});assert.deepEqual(reads,['主书']);assert.equal(docs.length,4);assert.ok(docs.some(d=>d.text==='乙的内嵌设定'));assert.ok(!docs.some(d=>d.text==='不可读取'));
});
