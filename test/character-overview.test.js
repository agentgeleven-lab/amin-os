import test from 'node:test';
import assert from 'node:assert/strict';
import { readCharacterOverview } from '../apps/characters/overview.js';
import * as characters from '../apps/characters/model.js';
import * as inventory from '../apps/inventory/model.js';
import * as relations from '../apps/relationships/model.js';
import * as scene from '../apps/scene/model.js';
import * as journal from '../apps/journal/model.js';
import { mount } from '../apps/characters/view.js';
import { createCharactersService } from '../apps/characters/service.js';
import { publishExternalMetadataChange } from '../apps/shared/operations.js';

function fixture() {
    const ctx = { chat: [{ mes: 'arrive', name: 'Narrator' }], chatMetadata: {} };
    ctx.chatMetadata[characters.KEY] = characters.appendSnapshot(characters.emptyStore(), ctx.chat, { version: 1, characters: ['hero', 'other'].map(id => ({ id, name: '同名人物', kind: 'pc', notes: '', stats: [] })) });
    ctx.chatMetadata[inventory.KEY] = inventory.buildRestoreStore(ctx, { version: 1, items: ['hero', 'other'].map(ownerId => ({ id: ownerId + '-item', ownerId, name: '药水', quantity: 1, equipped: false, notes: '' })), balances: [{ id: 'coins', ownerId: 'hero', name: '金币', unit: '枚', amount: 12, notes: '' }], ledger: [] });
    return ctx;
}

test('overview reads explicit ownership and never persists derived copies or binds same names', () => {
    const ctx = fixture(), before = structuredClone(ctx);
    const result = readCharacterOverview(ctx, 'hero');
    assert.deepEqual(result.items.map(item => item.id), ['hero-item']);
    assert.equal(result.balances[0].amount, 12);
    result.items[0].quantity = 100;
    assert.deepEqual(ctx, before);
    assert.throws(() => readCharacterOverview(ctx, 'missing'), /不存在/);
});

test('overview reports missing references and requires explicit scene participant IDs', () => {
    const ctx = fixture();
    ctx.chatMetadata[relations.KEY] = relations.appendSnapshot(relations.emptyStore(), ctx.chat, { ...relations.emptyState(), relationships: [{ id: 'r', fromId: 'hero', toId: 'deleted', type: 'directed', label: '友人', notes: '', strength: 10 }] });
    const current = { ...scene.emptyState(), activeSceneId: 'room', scenes: { room: scene.validateScene({ id: 'room', name: '房间', participants: '同名人物', participantIds: ['other'] }) } };
    ctx.chatMetadata[scene.KEY] = scene.appendEvent(scene.emptyStore(), ctx.chat, { op: 'restore', reason: 'fixture', details: {}, state: current }, { eventId: 's', at: new Date().toISOString() });
    const result = readCharacterOverview(ctx, 'hero');
    assert.equal(result.relationships[0].to.missing, true);
    assert.equal(result.scene.present, null);
    assert.equal(readCharacterOverview(ctx, 'other').scene.present.id, 'room');
});

test('one damaged app does not hide readable assets and other chat has no inherited overview', () => {
    const ctx = fixture(); ctx.chatMetadata[journal.KEY] = { version: 999 };
    const result = readCharacterOverview(ctx, 'hero');
    assert.equal(result.items.length, 1);
    assert.match(result.errors.join(' '), /记忆/);
    ctx.chat = [{ mes: 'different branch', name: 'Narrator' }];
    assert.throws(() => readCharacterOverview(ctx, 'hero'), /不存在/);
});

test('idle overview polling never serializes added histories and detects roots, append tails and announced in-place edits', () => {
    const ctx = fixture(); ctx.getCurrentChatId = () => 'overview-chat';
    for (const key of [journal.KEY, scene.KEY, relations.KEY]) {
        ctx.chatMetadata[key] = { events: [{ id: 'old', payload: 'large history' }], toJSON() { throw Error('history serialization forbidden'); } };
    }
    const api = createCharactersService(() => ctx); let updates = 0;
    const unsubscribe = api.subscribe(() => updates++);
    for (let i = 0; i < 10; i++) api.sync();
    assert.equal(updates, 0);
    ctx.chatMetadata[journal.KEY].events.push({ id: 'new' }); api.sync();
    assert.equal(updates, 1);
    ctx.chatMetadata[scene.KEY] = { ...ctx.chatMetadata[scene.KEY] }; api.sync();
    assert.equal(updates, 2);
    ctx.chatMetadata[relations.KEY].events[0].payload = 'in-place update';
    publishExternalMetadataChange(() => ctx, [[relations.KEY]]);
    assert.equal(updates, 3);
    api.sync(); assert.equal(updates, 3);
    unsubscribe(); api.dispose();
});

class Element {
    constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    dispatchEvent(event) { for (const callback of [...(this.listeners.get(event.type) ?? [])]) callback(event); return true; }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = element => !element.hidden && (!element.parent || visible(element.parent));
const find = (root, label, tag = 'button') => walk(root).find(element => visible(element) && element.tagName === tag.toUpperCase() && (element.textContent === label || element.getAttribute('aria-label') === label));
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
function fire(element, type = 'input') { element.dispatchEvent({ type, target: element, preventDefault() {} }); }
async function click(root, label) { const node = find(root, label); assert.ok(node, `missing button: ${label}`); if (!node.disabled) fire(node, 'click'); await settle(); return node; }

test('overview UI renders collapsible read-only sections, refreshes canonical assets, and opens effects', async () => {
    const ctx = fixture(); ctx.getCurrentChatId = () => 'overview-chat';
    const api = createCharactersService(() => ctx), opened = [];
    const doc = { createElement: tag => new Element(tag, doc), defaultView: { Event }, activeElement: null };
    const root = doc.createElement('div');
    const view = mount(root, { service: api, dice: { busy: () => false }, document: doc, openApp: async app => opened.push(app) });
    assert.match(root.textContent, /人物关联总览/);
    assert.match(root.textContent, /金币：12 枚/);
    assert.ok(walk(root).some(node => node.tagName === 'DETAILS'));
    assert.match(root.textContent, /日程不能作为实际位置/);
    assert.match(root.textContent, /不能可靠归属到人物 ID/);
    const state = inventory.readInventory(ctx); state.balances[0].amount = 8;
    ctx.chatMetadata[inventory.KEY] = inventory.buildRestoreStore(ctx, state);
    api.sync(); assert.match(root.textContent, /金币：8 枚/);
    await click(root, '查看能力面板'); assert.deepEqual(opened, ['effects']);
    view.dispose(); api.dispose();
});
