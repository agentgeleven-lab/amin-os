import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from '../apps/effects/view.js';
import {durationFields,durationInMinutes,timingLabel} from '../apps/effects/timing-view.js';
import {createEffects} from '../apps/effects/service.js';
import {KEY,empty,change,activeEffects} from '../apps/effects/model.js';
import {KEY as SCENE_KEY,emptyState,chatPath} from '../apps/scene/model.js';

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

test('action page previews and confirms elapsed time without invoking generation',()=>withDocument(async()=>{
 const f=fixture();await click(f.target,'行动结算');edit(f.target,'行动名称','休息');edit(f.target,'耗时（分钟，0 不推进）','10');
 await click(f.target,'预览行动结算');assert.match(f.target.textContent,/剧情时间推进 10 分钟/);assert.equal(f.saves(),0);
 await click(f.target,'确认行动结算');assert.equal(f.saves(),1);assert.match(f.target.textContent,/行动已结算/);assert.ok(find(f.target,'复制固定结果'));f.close();
}));

test('duration units are exact integers and reject ambiguous or oversized durations',()=>{
 assert.equal(durationInMinutes('2','hours'),120);assert.equal(durationInMinutes('3','days'),4320);
 for(const [amount,unit]of [['','minutes'],['1.5','hours'],['-1','days'],['1','rounds'],['5256001','minutes']])assert.throws(()=>durationInMinutes(amount,unit));
});

test('editing other effect data preserves timer until an explicit reset or removal',()=>withDocument(()=>{
 const parent=new Element('div'),form=durationFields(parent,{effect:{timing:{durationMinutes:90}},clock:clock(0)});
 assert.equal(form.read(),undefined);edit(parent,'计时方式','set','select');edit(parent,'持续时长','2');edit(parent,'时长单位','hours','select');assert.equal(form.read(),120);
 edit(parent,'计时方式','none','select');assert.equal(form.read(),null);
 const missing=new Element('div'),unclocked=durationFields(missing);edit(missing,'计时方式','set','select');assert.throws(()=>unclocked.read(),/设置游戏时间/);
}));

test('confirmed timed effect retains one applied record on save failure and retry does not create another',()=>withDocument(async()=>{
 const f=fixture();try{
  await click(f.target,'生效中');await click(f.target,'建立生效记录');edit(f.target,'技能','shield','select');edit(f.target,'目标','同伴');edit(f.target,'作用层面','防御');edit(f.target,'计时方式','set','select');edit(f.target,'持续时长','2');edit(f.target,'时长单位','hours','select');
  assert.equal(activeEffects(f.api.read(),f.ctx.chat).length,0);f.fail(true);await click(f.target,'确认保存');
  const effect=activeEffects(f.api.read(),f.ctx.chat)[0];assert.equal(effect.timing.durationMinutes,120);assert.equal(f.ctx.chatMetadata[KEY].events.length,1);assert.equal(f.api.dirty(),true);
  assert.ok(find(f.target,'重试保存'));assert.equal(find(f.target,'确认保存').disabled,true);assert.match(f.target.textContent,/不会重复发动/);
  f.fail(false);await click(f.target,'重试保存');assert.equal(f.api.dirty(),false);assert.equal(f.ctx.chatMetadata[KEY].events.length,1);assert.equal(f.saves(),2);assert.equal(find(f.target,'重试保存'),undefined);
 }finally{f.close();}
}));

test('effect editor keeps running timer for instruction change and expired effect offers reset instead of resume',()=>withDocument(async()=>{
 const f=fixture();try{
  f.ctx.chatMetadata[KEY]=change(f.api.read(),f.ctx.chat,'create',{skillId:'shield',holder:'调查员',target:'同伴',scope:'防御',condition:'直到到期',durationMinutes:20},{clock:clock(0)});
  f.setClock(clock(10));await click(f.target,'生效中');assert.match(f.target.textContent,/剩余 10 游戏分钟/);await click(f.target,'调整 / 转让 / 时长');edit(f.target,'当前指令','保护所有伤口','textarea');await click(f.target,'确认保存');
  const effect=activeEffects(f.api.read(),f.ctx.chat)[0];assert.equal(effect.timing.startedAt.minute,0);assert.equal(effect.command,'保护所有伤口');
  f.setClock(clock(30));f.view.open();assert.match(f.target.textContent,/已到期/);assert.equal(find(f.target,'暂停效果').disabled,true);assert.ok(find(f.target,'调整 / 转让 / 时长'));assert.ok(find(f.target,'解除'));
  assert.match(timingLabel({timingStatus:{state:'unknown'}}),/待确认/);
 }finally{f.close();}
}));
