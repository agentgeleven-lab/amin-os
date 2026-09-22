import test from 'node:test';
import assert from 'node:assert/strict';
import {installFloorButtons,latestStatusFloor} from '../apps/status/history-ui.js';

class Node {
  constructor(tag='div',text='',className=''){this.tag=tag;this.textContent=text;this.className=className;this.children=[];this.dataset={};this.style={};this.attrs={};this.hidden=false;this.isConnected=true;this.classList={add:name=>{this.className+=' '+name;}};}
  append(...nodes){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
  replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
  setAttribute(k,v){this.attrs[k]=String(v);}
  getAttribute(k){return this.attrs[k]??null;}
  querySelector(selector){return this.find(n=>selector==='button'?n.tag==='button':selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):false);}
  find(fn){for(const n of this.children){if(fn(n))return n;const child=n.find(fn);if(child)return child;}return null;}
  click(){return this.onclick?.();}
  focus(){}scrollIntoView(){}
}
function setup({chat=[{mes:'A',name:'旅人'},{mes:'B',name:'守卫'}],managed=false,openWorkbench}={}){
  const ctx={chat,chatMetadata:{variables:{状态栏:'keep'}},characters:[{avatar:'card.png'}],characterId:0,getCurrentChatId:()=>1};
  const nodes=chat.map((message,index)=>{const element=new Node();element.setAttribute('mesid',index);element.append(new Node('div',message.mes));return element;});
  const node=(...args)=>new Node(...args),root={createElement:tag=>node(tag),querySelectorAll:()=>nodes};
  let participant,enabled=true,syncs=0,disposed=0,observing=true;const subscribers=new Set(),calls=[];
  const history={sync(){syncs++;},list:()=>ctx.chat.map((m,index)=>({index,name:m.name,available:true,state:{项目:{世界:{地点:m.mes}}}})),subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);}};
  const surface=managed?{protocolVersion:1,isManagedOwnershipRequired:()=>true,registerParticipant(value){participant=value;}}:undefined;
  const view=async(host,options)=>{calls.push({host,options});options.validate();return {element:node('section','editable','test-workbench'),selectPage:page=>calls.push({page}),dispose(){disposed++;options.onClose();}};};
  const controller=installFloorButtons({history,node,enabled:()=>enabled,context:()=>ctx,root,surface,openWorkbench:openWorkbench??view,observe(listener){listener(nodes);return {dispose(){observing=false;}};}});
  const button=index=>nodes[index].find(n=>n.tag==='button'&&n.dataset.floorApp==='status');
  return {ctx,nodes,controller,button,calls,history,subscribers,get participant(){return participant;},get disposed(){return disposed;},get syncs(){return syncs;},get observing(){return observing;},setEnabled(value){enabled=value;controller.refresh();}};
}

test('latest non-system floor opens one editable workbench; old floors only show read-only records',async()=>{
  const s=setup({chat:[{mes:'old',name:'A'},{mes:'now',name:'B'},{mes:'system',is_system:true}]});
  assert.equal(latestStatusFloor(s.ctx.chat),1);assert.equal(latestStatusFloor([]),-1);
  assert.equal(s.button(2),null);
  s.button(0).click();assert.equal(s.calls.length,0);assert.equal(s.subscribers.size,1);
  const current=s.nodes[0].querySelector('.wsh-open-current');assert(current);
  await current.click();await Promise.resolve();
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].host.parent.parent,s.nodes[1]);
  const before=s.ctx.chatMetadata.variables.状态栏;
  await s.controller.openCurrent('rules');assert.equal(s.calls.length,2);assert.equal(s.calls[1].page,'rules');
  assert.equal(s.ctx.chatMetadata.variables.状态栏,before);
  s.controller.dispose();assert.equal(s.disposed,1);assert.equal(s.subscribers.size,0);assert.equal(s.observing,false);
  assert.deepEqual(s.nodes.map(n=>n.children.length),[1,1,1]);
});

test('swipe, deletion, chat switch and node recycling tear down stale current editors',async()=>{
  for(const change of [s=>{s.ctx.chat[1].swipe_id=1;},s=>{s.ctx.chat.pop();s.nodes[1].isConnected=false;},s=>{s.ctx.chatMetadata={variables:{状态栏:'other'}};},s=>{s.nodes[1].setAttribute('mesid','0');}]){
    const s=setup();assert.equal(await s.controller.openCurrent(),true);const validate=s.calls[0].options.validate;
    change(s);assert.throws(validate,/当前楼层已变化/);s.controller.refresh();assert.equal(s.disposed,1);
    s.controller.dispose();assert.equal(s.disposed,1);
  }
});

test('adding a message closes the previous current workbench and moves editing to the new floor',async()=>{
  const s=setup();await s.controller.openCurrent();s.ctx.chat.push({mes:'new',name:'C'});
  const added=new Node();added.setAttribute('mesid',2);s.nodes.push(added);s.controller.refresh(s.nodes);
  assert.equal(s.disposed,1);assert.equal(s.button(1).dataset.statusMode,'history');
  assert.equal(await s.controller.openCurrent(),true);assert.equal(s.calls[1].host.parent.parent,added);
  s.controller.dispose();
});

test('managed surfaces touch only owned message nodes and dispose when the host releases ownership',async()=>{
  const s=setup({managed:true});assert.equal(s.button(0),null);assert.equal(await s.controller.openCurrent(),false);
  const release=s.participant.didMount({element:s.nodes[1],mesid:1});assert(s.button(1));assert.equal(s.button(0),null);
  assert.equal(await s.controller.openCurrent(),true);release();assert.equal(s.disposed,1);assert.equal(s.button(1),null);
  s.controller.refresh();assert.equal(s.button(1),null);s.controller.dispose();
});

test('hiding floor entrances closes the editor and reopening honors the preference',async()=>{
  const s=setup();await s.controller.openCurrent();s.setEnabled(false);
  assert.equal(s.disposed,1);assert.equal(s.button(1).hidden,true);assert.equal(await s.controller.openCurrent(),false);
  s.setEnabled(true);assert.equal(await s.controller.openCurrent(),true);s.controller.dispose();
});

test('a closed asynchronous editor cannot attach late or close a replacement editor',async()=>{
  const pending=[];let disposed=0;
  const s=setup({openWorkbench:(host,options)=>new Promise(resolve=>pending.push({host,options,resolve}))});
  const first=s.controller.openCurrent();await Promise.resolve();s.button(1).click();
  const second=s.controller.openCurrent();await Promise.resolve();
  const view=entry=>({element:new Node('section','editor'),dispose(){disposed++;entry.options.onClose();}});
  pending[1].resolve(view(pending[1]));assert.equal(await second,true);
  pending[0].resolve(view(pending[0]));assert.equal(await first,false);
  assert.equal(s.button(1).attrs['aria-expanded'],'true');assert.equal(disposed,1);
  s.controller.dispose();assert.equal(disposed,2);
});
