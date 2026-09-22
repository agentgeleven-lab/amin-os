import test from 'node:test';
import assert from 'node:assert/strict';
import {empty,KEY,readStore,change,activeEffects,splitEffect,compile} from '../apps/effects/model.js';
import {LIBRARY_KEY,mergeLibrary,groupNames,abilityGroup,addGroup,renameGroup,removeGroup,moveAbility,deleteAbility,restoreAbility,UNGROUPED} from '../apps/effects/library.js';
import {createEffects} from '../apps/effects/service.js';
const skill=(id='a',group)=>({id,name:'能力'+id,book:'旧书',entryId:id,original:'完整原文'+id,reminder:'规则'+id,...(group?{ui:{group,icon:'★',custom:'保留'}}:{})});
const chat=[{name:'我',mes:'开始'}];
const store=()=>({...empty(),skills:[skill('a'),skill('b')],groups:[]});
const launch=(s,extra={})=>change(s,chat,'create',{skillId:'a',holder:'甲',targetMode:'direct',scope:'环境',condition:'主动解除',...extra});

test('legacy groups are registered without mutating abilities; unnamed abilities appear under ungrouped',()=>{
 const a=skill('a','旧分组'),b=skill('b'),legacy=[a,b],raw={version:1,skills:legacy,imported:[]};
 const before=JSON.stringify(raw),library=mergeLibrary(raw);
 assert.equal(JSON.stringify(raw),before);assert.deepEqual(library.skills,legacy);
 assert.deepEqual(groupNames(library),[UNGROUPED,'旧分组']);assert.equal(abilityGroup(b),UNGROUPED);
 assert.deepEqual(mergeLibrary(library),library);
});
test('empty groups persist and group names are validated without overwriting old values',()=>{
 const s=addGroup(store(),'空分组');assert.ok(groupNames(s).includes('空分组'));
 assert.ok(groupNames(mergeLibrary({version:1,skills:s.skills,groups:s.groups,imported:[]})).includes('空分组'));
 for(const name of ['', ' ',UNGROUPED,'x'.repeat(41),'空分组'])assert.throws(()=>addGroup(s,name));
 assert.throws(()=>mergeLibrary({version:1,skills:[],imported:[],groups:{bad:true}}),/损坏/);
});
test('group rename and deletion preserve ability fields and do not modify effect snapshots',()=>{
 let s=store();s.skills[0]=skill('a','战斗');s=launch(s);const event=structuredClone(s.events),oldSkill=structuredClone(s.skills[0]);
 s=renameGroup(s,'战斗','法术');assert.equal(s.skills[0].ui.group,'法术');assert.equal(s.skills[0].ui.custom,'保留');
 assert.deepEqual(s.events,event);assert.equal(s.events[0].effect.skill.ui.group,'战斗');
 s=removeGroup(s,'法术');assert.equal(abilityGroup(s.skills[0]),UNGROUPED);assert.equal(s.skills.length,2);assert.deepEqual(s.events,event);
 assert.equal(s.skills[0].original,oldSkill.original);assert.equal(s.skills[0].reminder,oldSkill.reminder);
 assert.throws(()=>removeGroup(s,UNGROUPED));assert.throws(()=>renameGroup(s,UNGROUPED,'新'));
});
test('move ability validates group and preserves unrelated abilities; restoring into deleted group uses ungrouped',()=>{
 let s=addGroup(store(),'战斗');s=moveAbility(s,'a','战斗');const b=structuredClone(s.skills[1]);
 assert.deepEqual(s.skills[1],b);assert.throws(()=>moveAbility(s,'a','不存在'));
 s=deleteAbility(s,'a');s=removeGroup(s,'战斗');s=restoreAbility(s,'a');
 assert.equal(abilityGroup(s.skills[0]),UNGROUPED);assert.equal(s.skills[0].original,'完整原文a');
});
test('direct activation needs no target and discards hidden stale target text',()=>{
 const s=launch(store(),{target:'不应写入的旧目标'}),effect=activeEffects(s,chat)[0];
 assert.equal(effect.targetMode,'direct');assert.equal(effect.target,'');assert.equal(effect.holder,'甲');
 const prompt=compile(s,chat);assert.match(prompt,/无指定对象/);assert.doesNotMatch(prompt,/不应写入的旧目标/);
 assert.throws(()=>launch(store(),{holder:''}),/持有者/);
});
test('targeted legacy ability still requires a target and preserves old records unchanged',()=>{
 assert.throws(()=>change(store(),chat,'create',{skillId:'a',holder:'甲',scope:'环境',condition:'解除'}),/目标/);
 let s=launch(store(),{targetMode:'targeted',target:'乙'});delete s.events[0].effect.targetMode;
 const before=structuredClone(s.events);assert.equal(activeEffects(s,chat)[0].target,'乙');compile(s,chat);assert.deepEqual(s.events,before);
 assert.throws(()=>launch(store(),{targetMode:'typo'}),/方式无效/);
});
test('direct activation collision key includes ability, user and scope, not an empty global target',()=>{
 const s=launch(store());assert.throws(()=>launch(s),/同一能力/);
 assert.equal(activeEffects(launch(s,{skillId:'b'}),chat).length,2);
 assert.equal(activeEffects(launch(s,{holder:'乙'}),chat).length,2);
 assert.equal(activeEffects(launch(s,{scope:'另一范围'}),chat).length,2);
 assert.equal(activeEffects(launch(s,{targetMode:'targeted',target:'乙'}),chat).length,2);
});
test('direct mode defaults can be set per ability; split, pause and end retain no-target semantics',()=>{
 const s=store();s.skills[0].ui={targetMode:'direct'};
 const created=change(s,chat,'create',{skillId:'a',holder:'甲',scope:'环境',condition:'解除'}),id=created.events[0].effect.id;
 let split=splitEffect(created,chat,id,[{holder:'甲',scope:'光照'},{holder:'甲',scope:'声音'}]);
 assert.ok(activeEffects(split,chat).every(e=>e.targetMode==='direct'&&e.target===''));
 const [first,second]=activeEffects(split,chat);split=change(split,chat,'pause',{id:first.id,paused:true});split=change(split,chat,'end',{id:second.id,reason:'主动结束'});
 assert.equal(compile(split,chat),'');assert.equal(activeEffects(split,[]).length,0);
});
function fixture(){
 const ctx={getCurrentChatId:()=> 'a',chatMetadata:{},chat:structuredClone(chat),extensionSettings:{},saveSettingsDebounced:async()=>{},saveMetadata:async()=>{}};
 const api=createEffects(()=>ctx);return {ctx,api};
}
test('groups persist globally while chat saves contain only chat effects, never group metadata',async()=>{
 const {ctx,api}=fixture();await api.saveLibrary(api.capture(),s=>addGroup({...s,skills:[skill()]},'共享组'));
 await api.save(api.capture(),s=>launch(s));assert.ok(ctx.extensionSettings[LIBRARY_KEY].groups.includes('共享组'));
 assert.equal(ctx.chatMetadata[KEY].groups,undefined);
 ctx.chatMetadata={};assert.ok(groupNames(api.read()).includes('共享组'));assert.equal(api.read().events.length,0);
});
test('group changes invalidate old form tokens and asynchronous save failures roll back all library fields',async()=>{
 const {ctx,api}=fixture();const stale=api.capture();await api.saveLibrary(api.capture(),s=>addGroup(s,'一'));
 await assert.rejects(api.saveLibrary(stale,s=>s),/能力库已变化/);
 const before=structuredClone(ctx.extensionSettings[LIBRARY_KEY]);ctx.saveSettingsDebounced=async()=>{throw Error('disk');};
 await assert.rejects(api.saveLibrary(api.capture(),s=>renameGroup(s,'一','二')),/disk/);assert.deepEqual(ctx.extensionSettings[LIBRARY_KEY],before);
});
test('group migration is idempotent and moving an imported legacy ability does not reimport the old variant',async()=>{
 const {ctx,api}=fixture();ctx.chatMetadata[KEY]={...empty(),skills:[skill('a','旧组')]};api.read();
 await api.saveLibrary(api.capture(),s=>renameGroup(s,'旧组','新组'));
 ctx.chatMetadata={[KEY]:{...empty(),skills:[skill('a','旧组')]}};
 assert.equal(api.read().skills.length,1);assert.equal(abilityGroup(api.read().skills[0]),'新组');
 assert.equal(ctx.chatMetadata[KEY].skills[0].ui.group,'旧组');assert.equal(readStore(ctx).skills[0].ui.group,'新组');
});


test('transferring a direct effect cannot duplicate the same holder ability and scope',()=>{
 const s=launch(launch(store()),{holder:'乙'}),id=s.events[0].effect.id;
 assert.throws(()=>change(s,chat,'update',{id,holder:'乙',condition:'解除'}),/同一能力/);
 assert.equal(activeEffects(change(s,chat,'update',{id,holder:'丙',condition:'解除'}),chat)[0].holder,'丙');
});
test('failed metadata save after switching chat rolls back only its captured metadata object',async()=>{
 const {ctx,api}=fixture();await api.saveLibrary(api.capture(),s=>({...s,skills:[skill()]}));
 const oldMeta=ctx.chatMetadata;let reject;ctx.saveMetadata=()=>new Promise((_,r)=>{reject=r;});
 const saving=api.save(api.capture(),s=>launch(s));ctx.chatMetadata={newChat:true};
 reject(Error('disk'));await assert.rejects(saving,/disk/);
 assert.deepEqual(ctx.chatMetadata,{newChat:true});assert.equal(oldMeta[KEY],undefined);
});
