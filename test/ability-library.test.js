import test from 'node:test';
import assert from 'node:assert/strict';
import {createEffects} from '../apps/effects/service.js';
import {LIBRARY_KEY,mergeLibrary} from '../apps/effects/library.js';
import {KEY,empty,change,compile} from '../apps/effects/model.js';
const skill=()=>({id:'one',name:'所有权',book:'原世界书',entryId:'7',original:'完整原文',reminder:'旧规则',ui:{size:'wide',group:'概念'}});
function fixture(){
 const settings={};let c={characterId:0,chatMetadata:{},chat:[{name:'用户',is_user:true,mes:'开始'}],getCurrentChatId:()=> 'a',extensionSettings:settings,saveSettingsDebounced(){},async saveMetadata(){}};
 const get=()=>c,api=createEffects(get);
 return {api,get,switchChat(meta={},id='b'){c={...c,characterId:1,chatMetadata:meta,getCurrentChatId:()=>id};}};
}
test('global abilities survive character/chat switches and reload without a lorebook',async()=>{
 const f=fixture();await f.api.saveLibrary(f.api.capture(),s=>({...s,skills:[skill()]}));
 f.switchChat();assert.deepEqual(f.api.read().skills,[skill()]);assert.equal(f.api.read().events.length,0);
 const persisted=JSON.parse(JSON.stringify(f.get().extensionSettings));f.get().extensionSettings=persisted;
 const reloaded=createEffects(f.get);assert.deepEqual(reloaded.read().skills,[skill()]);assert.equal(f.get().loadWorldInfo,undefined);
});
test('legacy migration preserves variants and does not reimport or undo subsequent global edits',async()=>{
 const f=fixture(),legacy={...empty(),skills:[skill()]};f.get().chatMetadata[KEY]=legacy;
 f.api.read();assert.deepEqual(f.get().chatMetadata[KEY],legacy);
 await f.api.saveLibrary(f.api.capture(),s=>{s.skills[0].name='新名称';return s;});
 assert.equal(f.api.read().skills.length,1);assert.equal(f.api.read().skills[0].name,'新名称');
 f.switchChat({[KEY]:{...empty(),skills:[{...skill(),reminder:'独立版本'}]}});
 const migrated=f.api.read();assert.equal(migrated.skills.length,2);assert.equal(new Set(migrated.skills.map(s=>s.id)).size,2);
 assert.equal(f.api.read().skills.length,2);assert.equal(migrated.skills[1].original,'完整原文');
 assert.equal(f.get().extensionSettings[LIBRARY_KEY].skills.length,2);
});
test('effects stay chat-local and keep original rules after library edits',async()=>{
 const f=fixture();await f.api.saveLibrary(f.api.capture(),s=>({...s,skills:[skill()]}));
 await f.api.save(f.api.capture(),s=>change(s,f.get().chat,'create',{skillId:'one',holder:'甲',target:'乙',scope:'视觉',condition:'直到解除'}));
 const a=f.get().chatMetadata;assert.deepEqual(a[KEY].skills,[]);
 await f.api.saveLibrary(f.api.capture(),s=>{s.skills[0].reminder='新规则';return s;});
 assert.match(compile(f.api.read(),f.get().chat),/旧规则/);assert.doesNotMatch(compile(f.api.read(),f.get().chat),/新规则/);
 f.switchChat();assert.equal(compile(f.api.read(),f.get().chat),'');assert.equal(f.api.read().skills[0].reminder,'新规则');
 f.switchChat(a,'a');assert.match(compile(f.api.read(),f.get().chat),/旧规则/);
});
test('global saves reject stale forms and roll back settings failures',async()=>{
 const f=fixture();await f.api.saveLibrary(f.api.capture(),s=>({...s,skills:[skill()]}));const stale=f.api.capture();
 await f.api.saveLibrary(f.api.capture(),s=>{s.skills[0].name='修改';return s;});
 await assert.rejects(f.api.saveLibrary(stale,s=>s),/能力库已变化/);
 const before=structuredClone(f.get().extensionSettings[LIBRARY_KEY]);f.get().saveSettingsDebounced=async()=>{throw Error('disk');};
 await assert.rejects(f.api.saveLibrary(f.api.capture(),s=>{s.skills=[];return s;}),/disk/);
 assert.deepEqual(f.get().extensionSettings[LIBRARY_KEY],before);
});
test('unsupported library versions are not overwritten',()=>{assert.throws(()=>mergeLibrary({version:2,skills:[],imported:[]},[skill()]),/版本不兼容/);});

test('multiple launches keep distinct rule versions within the same chat',()=>{
 const history=[{mes:'开始'}];let store={...empty(),skills:[skill()]};
 store=change(store,history,'create',{skillId:'one',holder:'甲',target:'乙',scope:'视觉',condition:'直到解除'});
 store.skills[0].reminder='新规则';
 store=change(store,history,'create',{skillId:'one',holder:'甲',target:'丙',scope:'视觉',condition:'直到解除'});
 const text=compile(store,history);assert.match(text,/旧规则/);assert.match(text,/新规则/);
 const data=JSON.parse(text.slice(text.indexOf('{')));assert.equal(data.技能规则.length,2);
 assert.deepEqual(data.生效记录.map(e=>e.规则编号),[1,2]);
});
