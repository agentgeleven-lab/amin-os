import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from '../apps/effects/view.js';
import {durationFields,durationInMinutes,timingLabel} from '../apps/effects/timing-view.js';
import {createEffects} from '../apps/effects/service.js';
import {KEY,empty,change,activeEffects} from '../apps/effects/model.js';
import {KEY as SCENE_KEY,emptyState,chatPath} from '../apps/scene/model.js';
import {KEY as JOURNAL_KEY,empty as emptyJournal,change as changeJournal,currentEntries} from '../apps/journal/model.js';

class Element{
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attributes={};this.dataset={};this.listeners=new Map();this._text='';this.value='';this.hidden=false;this.disabled=false;this.isConnected=true;}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
 querySelectorAll(selector){return walk(this).filter(node=>selector==='[data-effect-mutation]'&&node.dataset.effectMutation!==undefined);}
 focus(){}
 closest(){return null;}
}
const walk=root=>[root,...root.children.flatMap(walk)];
const visible=node=>!node.hidden&&(!node.parentElement||visible(node.parentElement));
const find=(root,label,tag='button')=>walk(root).find(node=>visible(node)&&node.tagName===tag.toUpperCase()&&(node.textContent===label||node.getAttribute('aria-label')===label));
const edit=(root,label,value,tag='input')=>{const input=find(root,label,tag);assert.ok(input,`missing ${label}`);input.value=String(value);const event=tag==='select'?'change':'input';input['on'+event]?.();for(const fn of input.listeners.get(event)??[])fn();return input;};
const click=async(root,label)=>{const button=find(root,label);assert.ok(button,`missing ${label}`);assert.equal(button.disabled,false,`${label} disabled`);await button.onclick();};
function withDocument(fn){const before=globalThis.document;globalThis.document={createElement:tag=>new Element(tag),dispatchEvent(){}};return Promise.resolve().then(fn).finally(()=>{globalThis.document=before;});}
const clock=minute=>({year:2026,month:9,day:23,hour:10,minute,calendarLabel:''});
function fixture(){
 let fail=false,saves=0;
 const ctx={chatMetadata:{},chat:[{name:'调查员',is_user:true,mes:'开始'}],getCurrentChatId:()=> 'effects-ui',name1:'调查员',saveMetadata:async()=>{saves++;if(fail)throw Error('磁盘离线');}};
 ctx.chatMetadata[KEY]={...empty(),skills:[{id:'shield',name:'护盾',book:'自定义',entryId:'1',original:'持续护盾',reminder:'受到护盾保护'}]};
 const setClock=value=>ctx.chatMetadata[SCENE_KEY]={version:1,events:[{path:chatPath(ctx.chat),snapshot:{...emptyState(),clock:value}}]};setClock(clock(0));
 const api=createEffects(()=>ctx),target=new Element('div'),view=mount(target,{api});
 return {ctx,api,target,view,setClock,fail:value=>fail=value,saves:()=>saves,close(){view.dispose();api.dispose();}};
}

test('action templates fill only the current draft, never infer resource bindings or save',()=>withDocument(async()=>{
 const f=fixture();try{
  await click(f.target,'行动结算');edit(f.target,'行动模板','rest','select');await click(f.target,'填入模板到当前草稿');
  assert.equal(find(f.target,'行动名称','input').value,'休息');assert.equal(find(f.target,'耗时（分钟，0 不推进）','input').value,'60');
  assert.equal(find(f.target,'目标属性','select').value,'');assert.equal(find(f.target,'消耗资源','select').value,'');assert.equal(f.saves(),0);
  edit(f.target,'行动模板','healing','select');await click(f.target,'填入模板到当前草稿');assert.equal(find(f.target,'耗时（分钟，0 不推进）','input').value,'0');
  await click(f.target,'预览行动结算');assert.match(f.target.textContent,/至少设置/);assert.equal(f.saves(),0);
 }finally{f.close();}
}));

test('task reward configuration is explicit and passed only after opt-in',()=>withDocument(async()=>{
 const f=fixture();let input;
 const original=f.api.actionResources;f.api.actionResources=()=>({...original(),tasks:[{id:'quest',title:'调查',status:'active',progress:30,reward:'100 金币'}],rewards:[{kind:'item',itemId:'herb',label:'草药',value:2}]});
 f.api.stageAction=value=>{input=value;return {name:value.name,rows:['任务预览'],text:'固定结果'};};
 try{
  await click(f.target,'行动结算');edit(f.target,'关联任务','quest','select');assert.equal(find(f.target,'任务进度（0–100）','input').value,'30');
  edit(f.target,'任务结算状态','completed','select');assert.equal(find(f.target,'任务进度（0–100）','input').value,'100');
  const claim=find(f.target,'确认发放本次配置的任务奖励','input');assert.equal(!!claim.checked,false);claim.checked=true;claim.onchange();
  await click(f.target,'预览行动结算');assert.match(f.target.textContent,/至少一项奖励/);assert.equal(input,undefined);
  await click(f.target,'添加奖励项');edit(f.target,'奖励 1 的资源','0','select');edit(f.target,'奖励 1 的数量','3');
  await click(f.target,'预览行动结算');assert.equal(input.task.taskId,'quest');assert.equal(input.task.claimRewards,true);assert.equal(input.task.rewards[0].itemId,'herb');assert.equal(input.task.rewards[0].amount,3);assert.equal(f.saves(),0);
 }finally{f.close();}
}));

test('already claimed task disables reward checkbox and changing task clears opt-in',()=>withDocument(async()=>{
 const f=fixture();const original=f.api.actionResources;f.api.actionResources=()=>({...original(),tasks:[{id:'new',title:'新任务',status:'active',progress:10},{id:'old',title:'旧任务',status:'completed',progress:100,rewardClaimed:true}],rewards:[]});
 try{
  await click(f.target,'行动结算');edit(f.target,'关联任务','new','select');edit(f.target,'任务结算状态','completed','select');const claim=find(f.target,'确认发放本次配置的任务奖励','input');claim.checked=true;claim.onchange();
  edit(f.target,'关联任务','old','select');assert.equal(claim.checked,false);assert.equal(claim.disabled,true);assert.match(f.target.textContent,/不能重复发放/);
 }finally{f.close();}
}));

test('task-only action confirms through the real service without executing descriptive rewards',()=>withDocument(async()=>{
 const f=fixture();try{
  f.ctx.chatMetadata[JOURNAL_KEY]=changeJournal(emptyJournal(),f.ctx.chat,'create',{id:'quest',kind:'task',title:'调查',body:'查明来源',progress:20,status:'active',reward:'自动获得一百金币'});
  await click(f.target,'行动结算');edit(f.target,'关联任务','quest','select');edit(f.target,'任务结算状态','completed','select');
  await click(f.target,'预览行动结算');assert.match(f.target.textContent,/本次未发放任务奖励/);assert.equal(currentEntries(f.ctx.chatMetadata[JOURNAL_KEY],f.ctx.chat)[0].progress,20);assert.equal(f.saves(),0);
  await click(f.target,'确认行动结算');assert.equal(currentEntries(f.ctx.chatMetadata[JOURNAL_KEY],f.ctx.chat)[0].progress,100);assert.equal(f.saves(),1);
 }finally{f.close();}
}));

test('task changed after preview rejects confirmation before any save',()=>withDocument(async()=>{
 const f=fixture();try{
  f.ctx.chatMetadata[JOURNAL_KEY]=changeJournal(emptyJournal(),f.ctx.chat,'create',{id:'quest',kind:'task',title:'调查',body:'查明来源',progress:20,status:'active'});
  await click(f.target,'行动结算');edit(f.target,'关联任务','quest','select');edit(f.target,'任务结算状态','completed','select');await click(f.target,'预览行动结算');
  f.ctx.chatMetadata[JOURNAL_KEY]=changeJournal(f.ctx.chatMetadata[JOURNAL_KEY],f.ctx.chat,'update',{...currentEntries(f.ctx.chatMetadata[JOURNAL_KEY],f.ctx.chat)[0],progress:50});
  await click(f.target,'确认行动结算');assert.equal(f.saves(),0);assert.equal(currentEntries(f.ctx.chatMetadata[JOURNAL_KEY],f.ctx.chat)[0].progress,50);assert.match(f.target.textContent,/变化|变更/);
 }finally{f.close();}
}));
