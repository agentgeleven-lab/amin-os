import test from 'node:test';
import assert from 'node:assert/strict';
import { relocateStatus } from '../apps/status/relocate.js';
const state = () => ({版本:1,项目:{玩家:{生命:{当前:10,最大:20},背包:['地图']},世界:{天气:'晴'}}});
test('rename retains project order, fields and unrelated rules without mutating source',()=>{
 const input=state(), rules={'状态栏.项目.玩家.生命.当前':{min:0},'状态栏.项目.玩家2.生命':{max:9},'其他.玩家':{type:'text'}};
 const result=relocateStatus(input,rules,{kind:'rename',project:'玩家',target:'主角',base:input.项目.玩家});
 assert.deepEqual(Object.keys(result.state.项目),['主角','世界']);
 assert.deepEqual(result.state.项目.主角,input.项目.玩家);
 assert.deepEqual(result.rules['状态栏.项目.主角.生命.当前'],{min:0});
 assert.deepEqual(result.rules['状态栏.项目.玩家2.生命'],{max:9});
 assert.ok(input.项目.玩家);assert.ok(rules['状态栏.项目.玩家.生命.当前']);
});
test('move preserves object/list types and migrates descendant rules',()=>{
 for(const field of ['生命','背包']){
 const input=state(), path=`状态栏.项目.玩家.${field}[0]`;
 const result=relocateStatus(input,{[path]:{type:'text'}},{kind:'move',project:'玩家',target:'世界',field,base:input.项目.玩家[field]});
 assert.deepEqual(result.state.项目.世界[field],input.项目.玩家[field]);
 assert.equal(Object.hasOwn(result.state.项目.玩家,field),false);
 assert.ok(result.rules[`状态栏.项目.世界.${field}[0]`]);
 assert.ok(input.项目.玩家[field]);
 }
});
test('reject duplicates, stale edits, invalid names, missing destinations and rule collisions',()=>{
 const input=state();
 const rename={kind:'rename',project:'玩家',target:'主角',base:input.项目.玩家};
 assert.throws(()=>relocateStatus(input,{}, {...rename,target:'世界'}),/已存在/);
 assert.throws(()=>relocateStatus(input,{}, {...rename,base:{}}),/已更新/);
 assert.throws(()=>relocateStatus(input,{}, {...rename,target:'__proto__'}),/无效/);
 const move={kind:'move',project:'玩家',target:'世界',field:'生命',base:input.项目.玩家.生命};
 assert.throws(()=>relocateStatus(input,{}, {...move,target:'消失'}),/已被删除/);
 input.项目.世界.生命=100;
 assert.throws(()=>relocateStatus(input,{},move),/同名/);
 delete input.项目.世界.生命;
 assert.throws(()=>relocateStatus(input,{'状态栏.项目.玩家.生命':{},'状态栏.项目.世界.生命':{}},move),/规则/);
 assert.deepEqual(input,state());
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('HUD transfer uses explicit bridge command and migrates ordering after success',async()=>{
 const html=readFileSync(new URL('../apps/status/hud.html',import.meta.url),'utf8');
 const fn=html.slice(html.indexOf('async function submitRelocate('),html.indexOf('function captureDraft()'));
 const input=state(), nodes={targetProject:{value:'世界'}};
 let command, closed=false, locked=false;
 const sandbox={demo:false,data:input,JSON,Error,Array,$:id=>nodes[id],view:{order:['玩家','世界'],closed:['玩家'],fieldOrder:{玩家:['生命','背包'],世界:['天气']}},
 lock:v=>{locked=v;},decode:v=>v,saveView(){},closeEditor(){closed=true;},render(){},status(){},own:(o,k)=>Object.hasOwn(o,k),
 STscript:async value=>{command=value;return relocateStatus(input,{},JSON.parse(value.slice('/amin-status-relocate '.length))).state;}};
 vm.createContext(sandbox);vm.runInContext(fn,sandbox);
 await sandbox.submitRelocate({relocate:'move',p:'玩家',k:'生命',base:input.项目.玩家.生命},'生命');
 assert.ok(command.startsWith('/amin-status-relocate '));
 assert.deepEqual(Array.from(sandbox.view.fieldOrder.玩家),['背包']);
 assert.deepEqual(Array.from(sandbox.view.fieldOrder.世界),['天气','生命']);
 assert.equal(closed,true);assert.equal(locked,false);
});
test('HUD rejected rename keeps editor and local display preferences unchanged',async()=>{
 const html=readFileSync(new URL('../apps/status/hud.html',import.meta.url),'utf8');
 const fn=html.slice(html.indexOf('async function submitRelocate('),html.indexOf('function captureDraft()'));
 let closed=false,locked=false;
 const sandbox={demo:false,JSON,Error,decode:v=>v,lock:v=>{locked=v;},STscript:async()=>{throw Error('项目名称已存在。');},closeEditor(){closed=true;},view:{order:['玩家','世界']}};
 vm.createContext(sandbox);vm.runInContext(fn,sandbox);
 await assert.rejects(sandbox.submitRelocate({relocate:'rename',p:'玩家',base:{}},'世界'),/已存在/);
 assert.equal(closed,false);assert.equal(locked,false);assert.deepEqual(sandbox.view.order,['玩家','世界']);
});
