import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY as CHARACTERS, readCharacters, buildRestore as restoreCharacters, validateState as validateCharacters } from '../apps/characters/model.js';
import { readCharacterAppearance } from '../apps/characters/appearance.js';
import { KEY as INVENTORY, emptyState, transition, readInventory, validateState, buildRestoreStore } from '../apps/inventory/model.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';

const now = '2026-09-23T10:00:00.000Z';
let sequence = 0;
const nextId = () => `appearance_${++sequence}`;
const people = () => ['alice', 'bob'].map(id => ({ id, name: id, kind: 'pc', notes: '', stats: [] }));
const garment = (extra = {}) => ({ name: '旅行外套', ownerId: 'alice', quantity: 1, equipped: true, notes: '', wear: { slot: 'torso', layer: 'outer', description: '深蓝色长外套' }, condition: { wetness: 0, dirt: 10, damage: 0, notes: '' }, reason: '整理行装', ...extra });
const step = (state, op, data) => transition(state, op, data, { id: nextId(), createId: nextId, at: now, ownerIds: ['alice', 'bob'] }).state;
function fixture() {
    const ctx = { chatId: 'appearance-chat', characterId: 0, chat: [{ name: 'KP', mes: '出发', is_user: false, swipe_id: 0 }], chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 生命: { 当前: 7, 最大: 10 }, 力量: 3 } } }) }, unrelated: { keep: true } }, saveMetadata: async () => {} };
    ctx.chatMetadata[CHARACTERS] = restoreCharacters(ctx, { version: 1, characters: people() }, { id: nextId(), at: now });
    return ctx;
}
function change(adapter, ctx, action, target, data, operationId = nextId()) {
    return adapter.apply(ctx, { module: adapter.id, action, target, data, reason: '本楼剧情已经发生' }, { operationId, now });
}
function apply(ctx, result) { for (const patch of result.patches) { assert.equal(patch.path.length, 1); ctx.chatMetadata[patch.path[0]] = patch.value; } }

test('wearable identity and physical condition survive transfer, while source appearance updates automatically', () => {
    const ctx = fixture(), initial = step(emptyState(), 'save-item', garment({ newId: 'coat' }));
    ctx.chatMetadata[INVENTORY] = buildRestoreStore(ctx, initial, { id: nextId(), at: now });
    assert.equal(readCharacterAppearance(ctx, 'alice').worn[0].itemId, 'coat');
    apply(ctx, change(inventory, ctx, 'set-condition', 'coat', { condition: { wetness: 80, damage: 25, notes: '雨中翻越铁丝网' } }));
    assert.deepEqual(readCharacterAppearance(ctx, 'alice').worn[0].condition, { wetness: 80, dirt: 10, damage: 25, notes: '雨中翻越铁丝网' });
    const original = structuredClone(ctx.chatMetadata), result = change(inventory, ctx, 'transfer-item', 'coat', { quantity: 1, toOwnerId: 'bob' });
    assert.deepEqual(ctx.chatMetadata, original, 'adapter is pure'); apply(ctx, result);
    assert.equal(readInventory(ctx).items.length, 1); assert.equal(readInventory(ctx).items[0].id, 'coat'); assert.equal(readInventory(ctx).items[0].ownerId, 'bob');
    assert.equal(readCharacterAppearance(ctx, 'alice').worn.length, 0); assert.equal(readCharacterAppearance(ctx, 'bob').worn.length, 0);
    apply(ctx, change(inventory, ctx, 'equip-item', 'coat', { equipped: true }));
    assert.equal(readCharacterAppearance(ctx, 'bob').worn[0].condition.wetness, 80);
    const transfer = readInventory(ctx).ledger.find(entry => entry.op === 'transfer-item');
    assert.deepEqual(transfer.entries.map(entry => [entry.id, entry.ownerId, entry.delta]), [['coat', 'alice', -1], ['coat', 'bob', 1]]);
});

test('slot occupancy, individual garment quantities and bounded condition reject partial invalid changes', () => {
    const source = step(emptyState(), 'save-item', garment()), before = structuredClone(source);
    assert.throws(() => step(source, 'save-item', garment()), /已有穿戴/);
    assert.throws(() => step(emptyState(), 'save-item', garment({ quantity: 2 })), /逐件登记/);
    const layered = step(source, 'save-item', garment({ wear: { slot: 'torso', layer: 'base', description: '内衫' } }));
    assert.equal(layered.items.filter(item => item.equipped).length, 2);
    const unworn = step(source, 'save-item', garment({ equipped: false }));
    assert.throws(() => step(unworn, 'equip-item', { id: unworn.items[1].id, equipped: true, reason: '穿上' }), /已有穿戴/);
    for (const condition of [{ wetness: -1 }, { dirt: 101 }, { damage: 0.5 }, { damage: NaN }, { damage: Infinity }, { equipment: [] }, null]) assert.throws(() => step(source, 'set-condition', { id: source.items[0].id, condition, reason: '测试无效状态' }));
    assert.deepEqual(source, before);
});

test('old snapshots stay valid and optional appearance fields restore at the current branch', () => {
    const ctx = fixture(), oldCharacters = readCharacters(ctx), oldInventory = emptyState();
    assert.deepEqual(validateCharacters(oldCharacters), oldCharacters); assert.deepEqual(validateState(oldInventory), oldInventory);
    apply(ctx, change(characters, ctx, 'set-appearance', 'alice', { hairstyle: '束起的长发', description: '高挑，步伐轻快' }));
    const snapshot = readCharacters(ctx); assert.equal(snapshot.characters[0].appearance.hairstyle, '束起的长发');
    ctx.chat.push({ name: 'KP', mes: '雨夜', is_user: false, swipe_id: 0 });
    apply(ctx, change(characters, ctx, 'set-appearance', 'alice', { hairstyle: '散开的湿发' }));
    ctx.chat[1].swipe_id = 1; assert.equal(readCharacters(ctx).characters[0].appearance.hairstyle, '束起的长发');
    ctx.chatMetadata[CHARACTERS] = restoreCharacters(ctx, snapshot, { id: nextId(), at: now });
    assert.equal(readCharacters(ctx).characters[0].appearance.hairstyle, '束起的长发');
    ctx.chat[1].swipe_id = 0; assert.equal(readCharacters(ctx).characters[0].appearance.hairstyle, '散开的湿发');
});

test('character adapter creates only explicit safe references and cannot store independent stat numbers or credentials', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const stat = { id: 'hp', label: '生命', binding: '主角.生命', component: 'current', check: 'none' };
    apply(ctx, change(characters, ctx, 'save-stat', 'alice', stat));
    assert.equal(readCharacters(ctx).characters[0].stats[0].binding, '主角.生命');
    assert.deepEqual(ctx.chatMetadata.variables, before.variables);
    for (const invalid of [{ ...stat, value: 9 }, { ...stat, binding: '主角.缺失' }, { ...stat, component: 'value' }]) assert.throws(() => change(characters, ctx, 'save-stat', 'alice', invalid));
    assert.throws(() => change(characters, ctx, 'save-character', 'alice', { apiKey: 'bad' }), /不支持/);
    assert.throws(() => change(characters, ctx, 'set-stat', 'alice', { statId: 'hp', value: 9 }), /不支持/);
    assert.throws(() => change(characters, ctx, 'create-character', '__proto__', { name: 'bad', kind: 'npc' }), /编号/);
    assert.throws(() => change(characters, ctx, 'create-character', 'alice', { name: 'duplicate', kind: 'npc' }), /编号/);
    apply(ctx, change(characters, ctx, 'create-character', 'guide', { name: '向导', kind: 'npc', appearance: { features: '脸颊有疤痕' } }));
    assert.equal(readCharacters(ctx).characters.find(person => person.id === 'guide').appearance.features, '脸颊有疤痕');
    apply(ctx, change(characters, ctx, 'delete-stat', 'alice', { statId: 'hp' }));
    assert.deepEqual(ctx.chatMetadata.variables, before.variables);
});

test('inventory adapter requires stable explicit new IDs and keeps decimal transfers atomic', () => {
    const ctx = fixture();
    apply(ctx, change(inventory, ctx, 'create-item', 'potion', { name: '药剂', ownerId: 'alice', quantity: 3 }));
    assert.throws(() => change(inventory, ctx, 'transfer-item', 'potion', { quantity: 1, toOwnerId: 'bob' }), /显式 newId/);
    apply(ctx, change(inventory, ctx, 'transfer-item', 'potion', { quantity: 1, toOwnerId: 'bob', newId: 'potion_bob' }));
    assert.deepEqual(readInventory(ctx).items.map(item => [item.id, item.quantity]), [['potion', 2], ['potion_bob', 1]]);
    apply(ctx, change(inventory, ctx, 'create-balance', 'coins', { name: '金币', ownerId: 'alice', amount: 0.3, unit: '枚' }));
    apply(ctx, change(inventory, ctx, 'transfer-balance', 'coins', { amount: 0.1, toOwnerId: 'bob', newId: 'coins_bob' }));
    const snapshot = structuredClone(ctx.chatMetadata);
    assert.deepEqual(readInventory(ctx).balances.map(balance => balance.amount), [0.2, 0.1]);
    assert.throws(() => change(inventory, ctx, 'adjust-balance', 'coins', { delta: -0.3 }), /资源数量/);
    assert.throws(() => change(inventory, ctx, 'adjust-balance', 'coins', { delta: 0.0000001 }), /六位小数/);
    assert.throws(() => change(inventory, ctx, 'save-item', 'potion', { ownerId: 'bob' }), /参数无效/);
    assert.throws(() => change(inventory, ctx, 'create-item', 'bad id', { name: '伪造', ownerId: 'alice', quantity: 1 }), /编号/);
    assert.throws(() => change(inventory, ctx, 'create-item', 'missing_owner', { name: '伪造', ownerId: 'missing', quantity: 1 }), /持有人已不存在/);
    assert.throws(() => change(inventory, ctx, 'create-item', 'potion', { name: '重复', ownerId: 'alice', quantity: 1 }), /编号/);
    assert.deepEqual(ctx.chatMetadata, snapshot);
});

test('condition changes are branch-scoped and failed saves retry one immutable event', async () => {
    const ctx = fixture(), api = createInventoryService(() => ctx, { createId: nextId, now: () => now });
    try {
        api.saveItem(garment()); await api.confirm(); const id = api.read().items[0].id;
        ctx.chat.push({ name: 'KP', mes: '涉水过河', is_user: false, swipe_id: 0 });
        let attempts = 0; ctx.saveMetadata = async () => { if (++attempts === 1) throw Error('offline'); };
        api.setCondition({ id, condition: { wetness: 100 }, reason: '涉水' });
        await assert.rejects(api.confirm(), /offline/); const committed = structuredClone(ctx.chatMetadata[INVENTORY]);
        assert.equal(api.read().items[0].condition.wetness, 100); await api.retrySave();
        assert.deepEqual(ctx.chatMetadata[INVENTORY], committed);
        ctx.chat[1].swipe_id = 1; assert.equal(api.read().items[0].condition.wetness, 0);
        ctx.chat[1].swipe_id = 0; assert.equal(api.read().items[0].condition.wetness, 100);
    } finally { api.dispose(); }
});
