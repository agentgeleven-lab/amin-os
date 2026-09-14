import test from 'node:test';
import assert from 'node:assert/strict';
import {empty,change,activeEffects,compile,KEY} from '../apps/effects/model.js';
import {createEffects,PROMPT_KEY} from '../apps/effects/service.js';
const chat=()=>[{name:'旅人',is_user:true,mes:'发动技能',swipe_id:0}];
const seed=()=>({...empty(),skills:[{id:'s',name:'所有权',book:'书',entryId:'1',original:'原文',reminder:'持有到主动解除'}]});
const data={skillId:'s',holder:'甲',target:'乙',scope:'视觉',command:'黑暗',condition:'直到解除'};
test('ownership and instruction remain distinct; transfer and end replay correctly',()=>{
 const c=chat(),initial=seed(),s=change(initial,c,'create',data),e=activeEffects(s,c)[0];
 assert.equal(initial.events.length,0);assert.equal(e.skill.original,'原文');
 const updated=change(s,c,'update',{id:e.id,holder:'丙',command:'恢复视觉',condition:'直到解除'});
 assert.equal(activeEffects(updated,c)[0].holder,'丙');assert.match(compile(updated,c),/恢复视觉/);
 assert.equal(activeEffects(change(updated,c,'end',{id:e.id,reason:'主动放弃'}),c).length,0);
 assert.equal(compile({...updated,enabled:false},c),'');
 assert.throws(()=>change(s,c,'create',data),/已有记录/);
});
test('deleted, edited and swiped branches cannot retain future effects, including reload',()=>{
 const c=chat(),s=change(seed(),c,'create',data),saved=JSON.parse(JSON.stringify(s));
 assert.equal(activeEffects(saved,[]).length,0);
 assert.equal(activeEffects(saved,[{...c[0],swipe_id:1}]).length,0);
 assert.equal(activeEffects(saved,[{...c[0],mes:'没有发动'}]).length,0);
 assert.equal(activeEffects(saved,[...c,{mes:'继续'}]).length,1);
 assert.equal(activeEffects(saved,c).length,1);
});
test('rule snapshots survive library changes and budgets fail visibly without truncation',()=>{
 const c=chat(),s=change(seed(),c,'create',data);s.skills[0].reminder='新规则';
 assert.match(compile(s,c),/持有到主动解除/);assert.doesNotMatch(compile(s,c),/新规则/);
 assert.throws(()=>compile({...s,limit:10},c),/超过/);
});
function fixture(){const handlers={},prompts=new Map();let ctx={getCurrentChatId:()=> 'a',chatMetadata:{[KEY]:change(seed(),chat(),'create',data)},chat:chat(),saveMetadata:async()=>{},setExtensionPrompt:(key,text)=>prompts.set(key,text),eventTypes:{GENERATION_AFTER_COMMANDS:'start',CHAT_CHANGED:'chat',GENERATION_ENDED:'end'},eventSource:{on:(key,fn)=>handlers[key]=fn,removeListener(){}}};return {get:()=>ctx,switch:c=>ctx=c,handlers,prompts};}
test('host hook injects only supported generation types and clears on end/chat change',()=>{
 const f=fixture(),api=createEffects(f.get);assert.equal(api.supported,true);
 f.handlers.start('normal',{},false);assert.match(f.prompts.get(PROMPT_KEY),/所有权/);
 f.handlers.end();assert.equal(f.prompts.get(PROMPT_KEY),'');
 f.handlers.start('quiet');assert.equal(f.prompts.get(PROMPT_KEY),'');
 f.handlers.start('normal',{},true);assert.equal(f.prompts.get(PROMPT_KEY),'');
 f.handlers.start('normal');f.switch({...f.get(),chatMetadata:{},getCurrentChatId:()=> 'b'});f.handlers.chat();f.handlers.start('normal');assert.equal(f.prompts.get(PROMPT_KEY),'');api.dispose();
});
test('saving refuses stale forms and rolls back on persistence failure',async()=>{
 const f=fixture(),api=createEffects(f.get),token=api.capture();f.get().chat.push({mes:'new'});
 await assert.rejects(api.save(token,s=>s),/楼层已变化/);
 const fresh=api.capture(),before=structuredClone(f.get().chatMetadata[KEY]);f.get().saveMetadata=async()=>{throw Error('disk');};
 await assert.rejects(api.save(fresh,s=>({...s,enabled:false})),/disk/);assert.deepEqual(f.get().chatMetadata[KEY],before);
});
test('regeneration never receives effects from the assistant reply being replaced',()=>{
 const f=fixture();f.get().chat.push({name:'向导',is_user:false,mes:'后续效果'});
 f.get().chatMetadata[KEY]=change(seed(),f.get().chat,'create',data);
 createEffects(f.get);f.handlers.start('normal');assert.match(f.prompts.get(PROMPT_KEY),/所有权/);
 f.handlers.start('regenerate');assert.equal(f.prompts.get(PROMPT_KEY),'');
 f.handlers.start('swipe');assert.equal(f.prompts.get(PROMPT_KEY),'');
});
