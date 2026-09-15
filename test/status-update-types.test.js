import {canChangeType} from '../apps/status/type-permission.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeUpdates} from '../apps/status/state-tools.js';
const state=value=>({版本:1,项目:{人物:{字段:value,保留:'原值'}}});
test('existing fields can change between all five supported status types',()=>{
 const values=['待确定',25,true,['物品'],{当前:4,最大:10}];
 for(const before of values)for(const after of values){
  const initial=state(before),latest=structuredClone(initial),proposal={项目:{人物:{字段:after}}};
  const result=mergeUpdates(initial,latest,proposal,{allowTypeChange:true});
  assert.deepEqual(result.state.项目.人物.字段,after);assert.equal(result.state.项目.人物.保留,'原值');assert.deepEqual(initial,latest);
  if(after&&typeof after==='object')assert.notEqual(result.state.项目.人物.字段,after);
 }
});
test('invalid target types fail atomically and new fields remain forbidden',()=>{
 const initial=state('待确定');
 for(const value of [null,NaN,Infinity,{任意:'对象'},[1],{当前:11,最大:10},{当前:0,最大:0}])assert.throws(()=>mergeUpdates(initial,initial,{项目:{人物:{保留:'已变',字段:value}}}),/不支持/);
 assert.equal(initial.项目.人物.保留,'原值');
 assert.throws(()=>mergeUpdates(initial,initial,{项目:{人物:{新字段:1}}}),/不能新增/);
});
test('conversion does not overwrite a concurrent edit or resurrect deleted fields',()=>{
 const initial=state('待确定'),proposal={项目:{人物:{字段:20}}};
 assert.throws(()=>mergeUpdates(initial,state(15),proposal,{allowTypeChange:true}),/已改变/);
 assert.throws(()=>mergeUpdates(initial,{项目:{人物:{保留:'原值'}}},proposal,{allowTypeChange:true}),/已改变/);
 const latest=state('待确定');latest.项目.人物.保留='手动改动';assert.equal(mergeUpdates(initial,latest,proposal,{allowTypeChange:true}).state.项目.人物.保留,'手动改动');
});

test('type changes default to denied and user permission is scoped to field and target type',()=>{
 const initial=state('待确定'),proposal={项目:{人物:{字段:20}}};
 assert.throws(()=>mergeUpdates(initial,initial,proposal),/未授权/);
 assert.equal(canChangeType({updateNote:'字段的值现在是20'},'人物','字段',20),false);
 assert.equal(canChangeType({updateNote:'把字段改为数字'},'人物','字段',20),true);
 assert.equal(canChangeType({updateNote:'把字段改为数字'},'人物','保留',20),false);
 assert.equal(canChangeType({updateNote:'把字段改为数字'},'人物','字段',[]),false);
 assert.equal(canChangeType({instructions:'允许更改已有字段类型'},'人物','字段',20),true);
 assert.equal(canChangeType({instructions:'不允许更改已有字段类型'},'人物','字段',20),false);
 assert.equal(canChangeType({allowTypeChange:true},'人物','字段',20),true);
 const result=mergeUpdates(initial,initial,proposal,{allowTypeChange:(p,k,v)=>canChangeType({updateNote:'把字段改为数字'},p,k,v)});assert.equal(result.state.项目.人物.字段,20);
});
