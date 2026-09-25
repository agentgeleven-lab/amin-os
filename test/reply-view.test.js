import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from '../apps/reply/index.js';
import {ROOTS,MIGRATION_KEY,BACKUP_KEY,MIGRATION_OWNER,OWNED_VARIABLE_ROOTS,OWNERSHIP_FLOOR} from '../apps/state2/storage.js';
import {initializeState2} from '../apps/state2/runtime.js';

class FakeNode {
    constructor(tag) {
        this.tagName=tag.toUpperCase();this.children=[];this.parent=null;this.attributes={};this.listeners=new Map();
        this._text='';this.className='';this.id='';this.value='';this.checked=false;this.hidden=false;this.disabled=false;
        this.dispatched=[];this.classList={add:name=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),name])].join(' ');}};
    }
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this._text=String(value);this.replaceChildren();}
    append(...nodes){for(const child of nodes){child.remove?.();child.parent=this;this.children.push(child);}}
    replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
    before(node){if(!this.parent)throw Error('detached node');node.remove?.();node.parent=this.parent;this.parent.children.splice(this.parent.children.indexOf(this),0,node);}
    setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);}
    getAttribute(name){return this.attributes[name]??null;}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    dispatchEvent(event){this.dispatched.push(event.type);for(const fn of [...(this.listeners.get(event.type)??[])])fn(event);this['on'+event.type]?.(event);return true;}
    querySelectorAll(selector){return [...walk(this)].slice(1).filter(node=>matches(node,selector));}
    querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
    focus(){}setSelectionRange(){}
}
function* walk(node){yield node;for(const child of [...node.children])yield* walk(child);}
function matches(node,selector){
    if(selector.startsWith('.'))return node.className.split(/\s+/).includes(selector.slice(1));
    if(selector.startsWith('#'))return node.id===selector.slice(1);
    return node.tagName===selector.toUpperCase();
}
const descendants=root=>[...walk(root)];
const findButton=(root,label)=>descendants(root).find(node=>node.tagName==='BUTTON'&&node.textContent===label);
const findLabel=(root,label)=>descendants(root).find(node=>node.attributes['aria-label']===label);
const status=root=>descendants(root).find(node=>node.className.split(/\s+/).includes('ro-status')).textContent;
const fire=(node,type)=>node.dispatchEvent(new Event(type));
const wait=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
async function click(root,label){const button=findButton(root,label);assert.ok(button,'missing button: '+label);fire(button,'click');await wait();}
const cards=root=>descendants(root).filter(node=>node.className.split(/\s+/).includes('ro-card'));
const cardText=root=>cards(root).map(card=>card.children[1].textContent);

test('selected content exposes its saved rules and warns when the prompt is empty',async t=>{
    const f=fixture();t.after(()=>f.dispose());
    const selection=findLabel(f.root,'内容风格');
    selection.value='normal';fire(selection,'change');
    assert.match(findLabel(f.root,'内容风格生效状态').textContent,/提示词为空/);
    selection.value='violence';fire(selection,'change');
    const preview=descendants(f.root).find(n=>n.className==='amin-content-rules-preview');
    assert.ok(preview.textContent.trim().length>0);
    assert.equal(preview.parent.hidden,false);
    selection.value='none';fire(selection,'change');
    assert.equal(preview.parent.hidden,true);
});

function fixture(results=[],settings={}) {
    const documentRoot=new FakeNode('main'),form=new FakeNode('form'),input=new FakeNode('textarea');
    form.id='send_form';input.id='send_textarea';documentRoot.append(form,input);
    const doc={createElement:tag=>new FakeNode(tag),getElementById:id=>descendants(documentRoot).find(node=>node.id===id)??null,
        querySelector:selector=>descendants(documentRoot).find(node=>matches(node,selector))??null};
    const handlers=new Map(),eventSource={
        on(type,fn){if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},
        off(type,fn){handlers.get(type)?.delete(fn);},
        emit(type){for(const fn of [...(handlers.get(type)??[])])fn();},
    };
    const requests=[];
    const ctx={chatId:'chat-a',getCurrentChatId(){return this.chatId;},chatMetadata:{},characterId:0,name1:'玩家',name2:'守卫',
        characters:[{avatar:'guard.png',name:'守卫'}],chat:[{name:'守卫',is_user:false,mes:'守卫拦住了门。'}],
        worldInfoSettings:{},extensionSettings:{reply_options_mvp:{count:3,...settings}},saveSettingsDebounced(){},
        eventTypes:{CHAT_CHANGED:'chat_changed',MESSAGE_SENT:'message_sent'},eventSource,
        generateRaw(request){requests.push(request);const next=results.shift();return typeof next==='function'?next():Promise.resolve(next);},
    };
    const previousDocument=globalThis.document,previousTavern=globalThis.SillyTavern;
    globalThis.document=doc;globalThis.SillyTavern={getContext:()=>ctx};
    const target=new FakeNode('div');documentRoot.append(target);
    const view=mount({target,getContext:()=>ctx,instanceId:'reply-test-panel'});
    const root=descendants(target).find(node=>node.id==='reply-test-panel');
    assert.ok(root,'reply view mounted');
    return {root,input,ctx,requests,eventSource,dispose(){view.dispose();globalThis.document=previousDocument;globalThis.SillyTavern=previousTavern;}};
}

test('candidates remain switchable until message sent without writing story data',async t=>{
 const f=fixture(['["门外等待。","敲门询问。","离开门口。"]']);t.after(()=>f.dispose());
 f.input.value='我还在考虑。';const before=JSON.stringify([f.ctx.chatMetadata,f.ctx.extensionSettings,f.ctx.chat]);
 await click(f.root,'生成选项');const old=cards(f.root)[1];
 assert.equal(findButton(f.root,'保留满意项，重抽其余'),undefined);
 assert.equal(findButton(f.root,'换一个同方向方案'),undefined);
 fire(old,'click');assert.equal(cards(f.root).length,3);assert.match(f.input.value,/敲门询问/);
 const chosen=f.input.value;fire(old,'click');assert.equal(f.input.value,chosen);
 assert.equal(JSON.stringify([f.ctx.chatMetadata,f.ctx.extensionSettings,f.ctx.chat]),before);
 fire(cards(f.root)[0],'click');assert.equal(f.input.value,'我还在考虑。\n门外等待。');
 await click(f.root,'撤销填入');assert.equal(f.input.value,'我还在考虑。');
 fire(old,'click');f.eventSource.emit('message_sent');assert.equal(cards(f.root).length,0);
 assert.equal(f.input.value,'我还在考虑。\n敲门询问。');
});
test('whole-batch redraw replaces all candidates and keeps the draft intact on failure',async t=>{
 const f=fixture(['["一","二","三"]','invalid','["甲","乙","丙"]']);t.after(()=>f.dispose());
 f.input.value='原草稿';await click(f.root,'生成选项');await click(f.root,'生成 / 换一批');
 assert.deepEqual(cardText(f.root),['一','二','三']);assert.equal(f.input.value,'原草稿');
 await click(f.root,'生成 / 换一批');assert.deepEqual(cardText(f.root),['甲','乙','丙']);assert.equal(f.input.value,'原草稿');
});

test('previewed native story records can be excluded from a later request',async t=>{
    const f=fixture(['["候选一","候选二","候选三"]','["新候选一","新候选二","新候选三"]']);t.after(()=>f.dispose());
    f.ctx.extensionSettings.LittleWhiteBox={variablesMode:'2.0'};
    f.ctx.chatMetadata={
        variables:{[ROOTS.characters]:JSON.stringify({version:1,characters:[{id:'pc',name:'玩家',kind:'pc',appearance:{description:'红色斗篷'}}]})},
        [MIGRATION_KEY]:{version:1,owner:MIGRATION_OWNER,roots:[...OWNED_VARIABLE_ROOTS],createdAt:'2026-09-24'},
        [BACKUP_KEY]:{version:1,roots:{},source:{}},
        extensions:{LittleWhiteBox:{stateLogV2:{version:1,floors:{[OWNERSHIP_FLOOR]:{signature:MIGRATION_OWNER,roots:[...OWNED_VARIABLE_ROOTS]}}}}},
    };
    let completeRestore;
    const restoration=new Promise(resolve=>{completeRestore=resolve;});
    const runtime=initializeState2(()=>f.ctx,{interval:0,host:{LWB_StateV2:{applyText(){}}},document:null,
        restoreNative:async floor=>{assert.equal(floor,0);await restoration;return {restored:true};}});
    t.after(()=>runtime.destroy());
    const pending=runtime.restoreChat();await wait();
    await click(f.root,'刷新参考资料');
    assert.equal(findLabel(f.root,'引用资料：人物 · 玩家'),undefined,'unrestored branch data stays hidden');
    completeRestore();await pending;
    assert.equal(runtime.ready(f.ctx),true);
    await click(f.root,'刷新参考资料');
    const record=findLabel(f.root,'引用资料：人物 · 玩家');assert.ok(record);
    await click(f.root,'生成选项');
    assert.match(f.requests[0].prompt,/红色斗篷/);
    record.checked=false;fire(record,'change');
    await click(f.root,'生成 \/ 换一批');
    assert.doesNotMatch(f.requests[1].prompt,/红色斗篷/);
    assert.equal(f.ctx.chatMetadata.variables[ROOTS.characters].includes('红色斗篷'),true,'preview never rewrites State2');
});

test('a chat switch discards an in-flight result and blocks edits to old cards',async t=>{
    let complete;const pending=new Promise(resolve=>{complete=resolve;});
    const f=fixture(['["旧选项一","旧选项二","旧选项三"]',()=>pending]);t.after(()=>f.dispose());
    await click(f.root,'生成选项');assert.equal(cards(f.root).length,3);
    fire(findButton(f.root,'生成 / 换一批'),'click');await wait();assert.equal(f.requests.length,2);
    f.ctx.chatId='chat-b';f.ctx.chatMetadata={};f.eventSource.emit('chat_changed');
    complete('["不应显示的旧结果"]');await wait();
    assert.equal(cards(f.root).length,0);assert.equal(f.input.value,'');
    assert.match(status(f.root),/重新生成|上下文已更新/);
});
