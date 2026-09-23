import test from 'node:test';
import assert from 'node:assert/strict';
import { mount as mountCharacters } from '../apps/characters/view.js';
import { mount as mountInventory } from '../apps/inventory/view.js';
import { createCharactersService } from '../apps/characters/service.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { KEY as CHARACTERS, buildRestore } from '../apps/characters/model.js';
import { KEY as INVENTORY, emptyState, transition, buildRestoreStore } from '../apps/inventory/model.js';

class Element {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event); return true; }
    focus() { this.ownerDocument.activeElement = this; }
}
class Document extends EventTarget {
    constructor() { super(); this.activeElement = null; this.defaultView = { CustomEvent }; }
    createElement(tag) { return new Element(tag, this); }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label, tag = 'button') => walk(root).find(node => node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
async function click(root, label) { const node = find(root, label); assert.ok(node, label); assert.equal(node.disabled, false, label); node.dispatchEvent({ type: 'click', target: node, preventDefault() {} }); await settle(); }
function input(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, label); node.value = String(value); node.dispatchEvent({ type: tag === 'select' ? 'change' : 'input', target: node }); return node; }
function fixture() {
    let sequence = 0; const at = '2026-09-23T12:00:00.000Z';
    const ctx = { chatId: 'appearance-ui', characterId: 0, chat: [{ name: 'KP', mes: '出发', is_user: false }], chatMetadata: {}, saveMetadata: async () => {} };
    const people = ['alice', 'bob'].map(id => ({ id, name: id === 'alice' ? '调查员' : '向导', kind: 'pc', notes: '', stats: [], appearance: { description: '神情平静', hairstyle: '短发', features: '' } }));
    ctx.chatMetadata[CHARACTERS] = buildRestore(ctx, { version: 1, characters: people }, { id: 'people', at });
    const source = transition(emptyState(), 'save-item', { newId: 'coat', name: '蓝色外套', ownerId: 'alice', quantity: 1, equipped: true, notes: '', wear: { slot: 'torso', layer: 'outer', description: '铜扣与宽翻领' }, condition: { wetness: 0, dirt: 0, damage: 0, notes: '' }, reason: '出发前穿上' }, { id: 'coat_add', at, ownerIds: ['alice', 'bob'] }).state;
    ctx.chatMetadata[INVENTORY] = buildRestoreStore(ctx, source, { id: 'inventory_initial', at });
    const doc = new Document(), characterRoot = doc.createElement('div'), inventoryRoot = doc.createElement('div');
    const characterService = createCharactersService(() => ctx, { createId: () => `char_${++sequence}`, now: () => at });
    const inventoryService = createInventoryService(() => ctx, { createId: () => `item_${++sequence}`, now: () => at });
    const order = [], openApp = async app => { order.push(`open:${app}`); await Promise.resolve(); order.push(`ready:${app}`); };
    doc.addEventListener('amin:select-character', event => order.push(`select:${event.detail.app}:${event.detail.characterId}`));
    const dice = { busy: () => false, dirty: () => false, subscribe: () => () => {} };
    const characterView = mountCharacters(characterRoot, { document: doc, service: characterService, diceService: dice, openApp });
    const inventoryView = mountInventory(inventoryRoot, { document: doc, service: inventoryService });
    return { ctx, doc, characterRoot, inventoryRoot, characterService, inventoryService, order, dispose() { characterView.dispose(); inventoryView.dispose(); characterService.dispose(); inventoryService.dispose(); } };
}

test('character appearance editor persists body details while wearing comes from the existing item ID', async () => {
    const f = fixture();
    try {
        assert.match(f.characterRoot.textContent, /上身 · 外层：蓝色外套/); assert.match(f.characterRoot.textContent, /铜扣与宽翻领/);
        assert.equal(walk(f.characterRoot).find(node => node.dataset.itemId === 'coat')?.tagName, 'SECTION');
        await click(f.characterRoot, '编辑人物卡'); input(f.characterRoot, '发型', '束起的长发'); input(f.characterRoot, '外貌特征', '左眉有旧疤', 'textarea');
        await click(f.characterRoot, '保存人物卡');
        const person = f.characterService.read().characters[0];
        assert.equal(person.appearance.hairstyle, '束起的长发'); assert.equal(person.appearance.features, '左眉有旧疤');
        assert.deepEqual(Object.keys(person.appearance).sort(), ['description', 'features', 'hairstyle']);
        assert.equal(f.inventoryService.read().items[0].id, 'coat'); assert.match(f.characterRoot.textContent, /束起的长发/);
    } finally { f.dispose(); }
});

test('condition editor validates and previews before canonical clothing changes refresh the character', async () => {
    const f = fixture();
    try {
        await click(f.inventoryRoot, '物品状态'); input(f.inventoryRoot, '湿润程度（0–100）', 101); input(f.inventoryRoot, '变更原因', '雨淋');
        await click(f.inventoryRoot, '预览物品状态'); assert.equal(f.inventoryService.preview(), null); assert.equal(f.inventoryService.read().items[0].condition.wetness, 0);
        input(f.inventoryRoot, '湿润程度（0–100）', 70); input(f.inventoryRoot, '物品状态说明', '袖口淋湿', 'textarea'); await click(f.inventoryRoot, '预览物品状态');
        assert.equal(f.inventoryService.read().items[0].condition.wetness, 0); await click(f.inventoryRoot, '确认操作');
        assert.equal(f.inventoryService.read().items[0].condition.wetness, 70); assert.match(f.characterRoot.textContent, /湿润 70\/100/); assert.match(f.characterRoot.textContent, /袖口淋湿/);
    } finally { f.dispose(); }
});

test('person links open the app before dispatching its stable ID and protect an open destination editor', async () => {
    const f = fixture();
    try {
        await click(f.characterRoot, '资产与穿戴');
        assert.deepEqual(f.order, ['open:inventory', 'ready:inventory', 'select:inventory:alice']);
        assert.equal(find(f.inventoryRoot, '穿戴与外观').getAttribute('aria-selected'), 'true');
        assert.equal(find(f.inventoryRoot, '筛选所属人物', 'select').value, 'alice');
        await click(f.inventoryRoot, '编辑物品'); const name = input(f.inventoryRoot, '物品名称', '保留中的输入');
        f.doc.dispatchEvent(new CustomEvent('amin:select-character', { detail: { app: 'inventory', characterId: 'bob' } }));
        assert.equal(find(f.inventoryRoot, '物品名称', 'input'), name); assert.equal(name.value, '保留中的输入');
        assert.match(f.inventoryRoot.textContent, /尚未完成的编辑/);
        await click(f.characterRoot, '人物记忆'); await click(f.characterRoot, '个人日程'); await click(f.characterRoot, '人物关系');
        assert.ok(f.order.includes('select:journal:alice')); assert.ok(f.order.includes('select:scene:alice')); assert.ok(f.order.includes('select:relationships:alice'));
    } finally { f.dispose(); }
});
