import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeChatFloors} from '../apps/floor-scheduler.js';

function rig() {
    let queries = 0, nextFrame = 0;
    const frames = new Map(), observers = [], source = new EventEmitter();
    const element = (id = '', parentElement = null, isFloor = false) => ({
        nodeType:1, id, parentElement, isFloor,
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (selector === '#chat' && node.id === 'chat' || selector === '.amin-floor' && node.isFloor) return node;
            }
            return null;
        },
        querySelector(selector) { return selector === '#chat' ? this.chatChild ?? null : null; },
    });
    const body = element(), chat = element('chat', body), message = element('', chat), floor = element('', message, true), control = element('', floor);
    const document = {body, nodes:[message], querySelectorAll(selector) { assert.equal(selector, '#chat .mes[mesid]'); queries++; return this.nodes; }, defaultView:{
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        MutationObserver:class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(target, options) { this.target = target; this.options = options; }
            disconnect() { this.disconnected = true; }
        },
    }};
    const events = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED'].map(name => [name, name]));
    const options = {document, getContext:() => ({eventSource:source, eventTypes:events})};
    return {document, options, source, observers, frames, element, body, chat, message, floor, control,
        queries:() => queries,
        mutate(target, addedNodes = [], removedNodes = []) { observers.at(-1).callback([{type:'childList', target, addedNodes, removedNodes}]); },
        flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    };
}

test('multiple apps share their initial floor list, one observer and one host event subscription', () => {
    const r = rig(), left = [], right = [];
    const a = observeChatFloors(nodes => left.push(nodes), r.options);
    const b = observeChatFloors(nodes => right.push(nodes), r.options);
    assert.equal(r.queries(), 1);
    assert.equal(r.observers.length, 1);
    assert.equal(r.observers[0].target, r.body);
    assert.equal(r.source.listenerCount('MESSAGE_SWIPED'), 1);
    assert.equal(left.length, 1); assert.equal(right.length, 1);
    assert.equal(left[0], right[0]); assert.deepEqual(left[0], [r.message]);
    a.dispose(); b.dispose();
});

test('rendering or inserting owned windows and unrelated body updates never rescan chat', () => {
    const r = rig(), handle = observeChatFloors(() => {}, r.options);
    r.mutate(r.control, [r.element('', r.control)]);
    r.mutate(r.message, [r.floor]);
    r.mutate(r.message, [], [r.floor]);
    r.mutate(r.body, [r.element('', r.body)]);
    assert.equal(r.frames.size, 0); assert.equal(r.queries(), 1);
    handle.dispose();
});

test('host additions, deletion, version events and explicit refresh coalesce into one scan per frame', () => {
    const r = rig(), left = [], right = [];
    const a = observeChatFloors(nodes => left.push(nodes), r.options);
    const b = observeChatFloors(nodes => right.push(nodes), r.options);
    const added = r.element('', r.chat); r.document.nodes.push(added);
    r.mutate(r.chat, [added]); r.source.emit('MESSAGE_RECEIVED'); r.source.emit('MESSAGE_SWIPED'); b.refresh();
    assert.equal(r.frames.size, 1); assert.equal(r.queries(), 1);
    r.flush();
    assert.equal(r.queries(), 2); assert.equal(left.length, 2); assert.equal(right.length, 2);
    assert.equal(left[1], right[1]); assert.deepEqual(left[1], [r.message, added]);
    r.document.nodes = [added]; r.mutate(r.chat, [], [r.message]); r.source.emit('MESSAGE_DELETED');
    r.flush(); assert.deepEqual(left.at(-1), [added]); assert.equal(r.queries(), 3);
    a.dispose(); b.dispose();
});

test('host chat replacement and recycled message indices refresh subscribers', () => {
    const r = rig(), received = [], handle = observeChatFloors(nodes => received.push(nodes), r.options);
    const nextChat = r.element('chat', r.body), nextMessage = r.element('', nextChat);
    r.document.nodes = [nextMessage]; r.mutate(r.body, [nextChat], [r.chat]);
    r.flush(); assert.deepEqual(received.at(-1), [nextMessage]);
    r.observers[0].callback([{type:'attributes', target:nextMessage, attributeName:'mesid'}]);
    r.flush(); assert.equal(received.length, 3);
    handle.dispose();
});

test('disposal removes only that app until the final subscriber releases all shared resources', () => {
    const r = rig(); let left = 0, right = 0;
    const a = observeChatFloors(() => left++, r.options), b = observeChatFloors(() => right++, r.options);
    a.dispose(); a.refresh(); assert.equal(r.frames.size, 0);
    r.source.emit('MESSAGE_EDITED'); r.flush();
    assert.equal(left, 1); assert.equal(right, 2); assert.equal(r.observers[0].disconnected, undefined);
    b.refresh(); assert.equal(r.frames.size, 1); b.dispose(); b.dispose();
    assert.equal(r.frames.size, 0); assert.equal(r.observers[0].disconnected, true);
    assert.deepEqual(r.source.eventNames(), []);
    const c = observeChatFloors(() => {}, r.options);
    assert.equal(r.observers.length, 2); assert.equal(r.queries(), 3);
    c.dispose();
});
