import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeChatLifecycle} from '../apps/shared/chat-lifecycle.js';
import {captureContext,assertContext} from '../apps/shared/operations.js';

test('shared write entry refuses partial chats and old previews during rapid same-character switches',()=>{
    const listeners=new Map();
    const ctx={chatId:'a',getCurrentChatId(){return this.chatId;},characterId:0,characters:[{avatar:'a.png'}],chat:[{mes:'A'}],chatMetadata:{integrity:'a'},
        eventTypes:{CHAT_CHANGED:'changed'},eventSource:{on(e,f){listeners.set(e,f);},off(e){listeners.delete(e);}}};
    const gate=initializeChatLifecycle(()=>ctx);
    try{
        assert.throws(()=>captureContext(()=>ctx),{code:'CHAT_LOADING'});
        listeners.get('changed')('a');const token=captureContext(()=>ctx);
        ctx.chatId='b';assert.throws(()=>captureContext(()=>ctx),{code:'CHAT_LOADING'});
        ctx.chatMetadata={integrity:'b'};ctx.chat.splice(0,1,{mes:'B'});
        assert.throws(()=>captureContext(()=>ctx),{code:'CHAT_LOADING'});
        listeners.get('changed')('b');assert.doesNotThrow(()=>captureContext(()=>ctx));
        assert.throws(()=>assertContext(()=>ctx,token),{code:'STALE_CONTEXT'});
    }finally{gate.dispose();}
});
