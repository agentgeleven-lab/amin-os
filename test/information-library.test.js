import test from 'node:test';
import assert from 'node:assert/strict';
import {empty,apply,compile,groupRecords,KEY,resetRecord,modificationHistory} from '../apps/information/model.js';
import {createInformation} from '../apps/information/service.js';
const chat=[{name:'a',mes:'hello',is_user:true}];
const record=()=>{const fields=[{id:'f',category:'身份',label:'职业',value:'守卫',status:'known'},{id:'g',category:'档案',label:'年龄',value:'20',status:'known'}];return {id:'r',name:'甲',kind:'person',mode:'retcon',fields,baselineFields:structuredClone(fields)};};
test('generated archive survives character switch and reload without changing story',async()=>{
 const make=id=>({chatMetadata:{},chat,characters:[{avatar:id}],characterId:0,getCurrentChatId:()=>id,saveMetadata:async()=>{}}),a=make('a'),b=make('b');let ctx=a;
 const api=createInformation(()=>ctx);await api.saveRecord(api.capture(),record(),{report:{included:1}});assert.equal(a.chatMetadata[KEY],undefined);
 ctx=b;assert.equal(api.library().length,0);ctx={...a,chatMetadata:JSON.parse(JSON.stringify(a.chatMetadata))};assert.equal(api.library()[0].record.name,'甲');assert.equal(compile(api.read(),chat),'');
});
test('full before/after context accompanies changes until explicit reset',()=>{
 const r=record(),initial=apply(empty(),chat,r);assert.equal(compile(initial,chat),'');
 r.fields[0].value='名医';r.fields[0].status='edited';const changed=apply(initial,chat,r);const prompt=compile(changed,chat);assert.match(prompt,/名医/);assert.match(prompt,/年龄/);assert.match(prompt,/守卫/);
 r.fields[0].value='守卫';const reverted=apply(changed,chat,r);assert.equal(modificationHistory(reverted,chat).length,2);assert.equal(compile(resetRecord(reverted,chat,r.id),chat),'');
 r.fields=r.fields.filter(f=>f.id!=='g');assert.match(compile(apply(changed,chat,r),chat),/年龄/);
});
test('object shelves group repeated searches while separating names and kinds',()=>{
 const a=record();const groups=groupRecords([a,{...a,id:'b'},{...a,id:'c',kind:'thing'},{...a,id:'d',name:'乙'}]);assert.equal(groups.length,3);assert.equal(groups[0].records.length,2);
});
test('archive save failure restores prior library and stale chat cannot receive a result',async()=>{
 let fail=false,ctx={chatMetadata:{},chat,getCurrentChatId:()=> 'a',saveMetadata:async()=>{if(fail)throw Error('disk');}};const api=createInformation(()=>ctx);
 await api.saveRecord(api.capture(),record());const old=JSON.stringify(api.library());fail=true;await assert.rejects(api.saveRecord(api.capture(),{...record(),name:'changed'}),/disk/);assert.equal(JSON.stringify(api.library()),old);
 const token=api.capture();ctx={...ctx,chatMetadata:{},getCurrentChatId:()=> 'b'};await assert.rejects(api.saveRecord(token,record()),/变化/);assert.equal(api.library().length,0);
});

test('every confirmed edit is retained in order, no-op adds no reminder and reset is branch local',()=>{
 const r=record();r.fields[0].value='医生';let s=apply(empty(),chat,r);r.fields[0].value='城主';s=apply(s,chat,r);s=apply(s,chat,r);
 const log=modificationHistory(s,chat);assert.equal(log.length,2);assert.equal(log[0].before.fields[0].value,'守卫');assert.equal(log[0].snapshot.fields[0].value,'医生');assert.equal(log[1].before.fields[0].value,'医生');assert.equal(log[1].snapshot.fields[0].value,'城主');
 const later=[...chat,{mes:'later'}],reset=resetRecord(s,later,r.id);assert.equal(compile(reset,later),'');assert.equal(modificationHistory(reset,chat).length,2);
 const restored=structuredClone(reset.history.at(-1).snapshot);assert.equal(restored.fields[0].value,'守卫');restored.fields[0].value='旅人';assert.equal(modificationHistory(apply(reset,later,restored),later).length,1);
});
