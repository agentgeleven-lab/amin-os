import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeUpdates} from '../apps/status/state-tools.js';
const state=value=>({版本:1,项目:{人物:{字段:value,保留:'原值'}}});
test('existing fields can change between all five supported status types',()=>{
 const values=['待确定',25,true,['物品'],{当前:4,最大:10}];
 for(const before of values)for(const after of values){
  const initial=state(before),latest=structuredClone(initial),proposal={项目:{人物:{字段:after}}};
  const result=mergeUpdates(initial,latest,proposal);
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
 assert.throws(()=>mergeUpdates(initial,state(15),proposal),/已改变/);
 assert.throws(()=>mergeUpdates(initial,{项目:{人物:{保留:'原值'}}},proposal),/已改变/);
 const latest=state('待确定');latest.项目.人物.保留='手动改动';assert.equal(mergeUpdates(initial,latest,proposal).state.项目.人物.保留,'手动改动');
});
