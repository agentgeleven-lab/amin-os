import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatLifecycle} from '../apps/shared/chat-lifecycle.js';

function fixture(){
    const listeners=new Map();
    const ctx={characterId:0,characters:[{avatar:'a.png'}],chatId:'first',getCurrentChatId(){return this.chatId;},chat:[{mes:'one'}],chatMetadata:{integrity:'first'},
        eventTypes:{CHAT_CHANGED:'loaded',MESSAGE_DELETED:'deleted'},eventSource:{on(e,f){listeners.set(e,f);},off(e){listeners.delete(e);}}};
    return {ctx,listeners,gate:createChatLifecycle(()=>ctx),emit:(e,id)=>listeners.get(e)?.(id)};
}
test('startup and same-character overlapping loads remain blocked until matching completion',()=>{
    const f=fixture();assert.equal(f.gate.ready(),false);
    f.emit('loaded','first');assert.equal(f.gate.ready(),true);
    const captured={...f.ctx,getCurrentChatId:()=> 'first'};
    f.ctx.chatId='second';assert.equal(f.gate.ready(),false,'old metadata with new filename is not ready');
    assert.equal(f.gate.ready(captured),false,'a captured context cannot bypass the current host selection');
    f.emit('loaded','first');assert.equal(f.gate.ready(),false,'stale completion cannot unlock another chat');
    f.ctx.chatMetadata={integrity:'second'};f.ctx.chat.splice(0,1,{mes:'two'});
    assert.equal(f.gate.ready(),false);f.emit('loaded','second');assert.equal(f.gate.ready(),true);
    f.ctx.chatMetadata={};assert.equal(f.gate.ready(),false,'same filename with transient metadata is blocked');
    f.gate.dispose();assert.equal(f.listeners.size,0);
});
test('same-chat reload clearing shared chat array is blocked but explicit last-message deletion is supported',()=>{
    const f=fixture();f.emit('loaded','first');f.ctx.chat.length=0;
    assert.equal(f.gate.ready(),false);
    f.ctx.chat.push({mes:'restored'});assert.equal(f.gate.ready(),false);
    f.emit('loaded','first');assert.equal(f.gate.ready(),true);
    f.ctx.chat.length=0;f.emit('deleted');assert.equal(f.gate.ready(),true);
    f.gate.dispose();
});
