import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, LIMITS, emptyState, emptyStore, transition, change, readInventory, readStore, currentState, validateState, buildRestoreStore } from '../apps/inventory/model.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { KEY as CHARACTERS_KEY, buildRestore as restoreCharacters } from '../apps/characters/model.js';

const at = '2026-09-23T03:00:00.000Z';
const msg = (mes, swipe = 0) => ({ name: '调查员', is_user: false, mes, swipe_id: swipe });
let serial = 0;
const createId = () => `inventory_test_${++serial}`;
const context = () => ({ ownerIds: ['alice', 'bob'], at, createId });
const item = (overrides = {}) => ({ name: '急救包', ownerId: 'alice', quantity: 5, equipped: false, notes: '绷带和消毒药', reason: '初始登记', ...overrides });
const balance = (overrides = {}) => ({ name: '金币', ownerId: 'alice', amount: 12.5, unit: '枚', notes: '', reason: '初始登记', ...overrides });
function step(state, op, data) { return transition(state, op, data, context()).state; }
function fixture() {
    const ctx = { chatId: 'test-chat', characterId: 0, characters: [{ avatar: 'test.png' }], chat: [msg('抵达营地')], chatMetadata: {}, saveMetadata: async () => {} };
    ctx.chatMetadata[CHARACTERS_KEY] = restoreCharacters(ctx, { version: 1, characters: ['alice', 'bob'].map(id => ({ id, name: id, kind: 'pc', notes: '', stats: [] })) }, { id: createId(), at });
    return ctx;
}

test('inventory reads empty data without creating invented possessions or metadata', () => {
    const ctx = { chat: [], chatMetadata: {} }, before = structuredClone(ctx);
    assert.deepEqual(readInventory(ctx), emptyState()); assert.deepEqual(ctx, before);
});
test('item operations preserve integer quantity, equipment and immutable audit', () => {
    let state = step(emptyState(), 'save-item', item({ equipped: true }));
    const initial = structuredClone(state), id = state.items[0].id;
    state = step(state, 'consume-item', { id, quantity: 5, reason: '完成急救' });
    assert.equal(state.items[0].quantity, 0); assert.equal(state.items[0].equipped, false);
    assert.deepEqual(state.ledger[1].entries.map(entry => [entry.before, entry.delta, entry.after]), [[5, -5, 0]]);
    assert.equal(initial.items[0].quantity, 5);
    assert.throws(() => step(state, 'equip-item', { id, equipped: true, reason: '装备' }), /零数量/);
    assert.throws(() => step(initial, 'delete-item', { id, reason: '删除' }), /剩余物品/);
    assert.equal(step(state, 'delete-item', { id, reason: '清理空条目' }).items.length, 0);
});
test('transfers update both owners once, preserve units and never equip newly received stock', () => {
    const initial = step(emptyState(), 'save-item', item({ equipped: true })), sourceId = initial.items[0].id;
    const result = step(initial, 'transfer-item', { id: sourceId, quantity: 2, toOwnerId: 'bob', reason: '交给同行调查员' });
    assert.deepEqual(result.items.map(value => [value.ownerId, value.quantity, value.equipped]), [['alice', 3, true], ['bob', 2, false]]);
    assert.equal(result.ledger.at(-1).entries.reduce((sum, value) => sum + value.delta, 0), 0);
    assert.equal(initial.items[0].quantity, 5);
    assert.throws(() => step(initial, 'transfer-item', { id: sourceId, quantity: 6, toOwnerId: 'bob', reason: '不足' }), /不足/);
    assert.throws(() => step(initial, 'transfer-item', { id: sourceId, quantity: 1, toOwnerId: 'alice', reason: '同一人' }), /其他人物/);
});
test('currency accounts retain decimal precision and atomic transfer totals', () => {
    let state = step(emptyState(), 'save-balance', balance({ amount: 0.3 }));
    const sourceId = state.balances[0].id;
    state = step(state, 'transfer-balance', { id: sourceId, toOwnerId: 'bob', amount: 0.1, reason: '支付路费' });
    state = step(state, 'transfer-balance', { id: sourceId, toOwnerId: 'bob', amount: 0.1, reason: '补足路费' });
    assert.deepEqual(state.balances.map(value => [value.ownerId, value.amount]), [['alice', 0.1], ['bob', 0.2]]);
    assert.deepEqual(state.ledger.at(-1).entries.map(value => value.delta), [-0.1, 0.1]);
    assert.throws(() => step(state, 'adjust-balance', { id: sourceId, delta: -0.2, reason: '透支' }), /资源数量/);
    assert.throws(() => step(state, 'transfer-balance', { id: sourceId, toOwnerId: 'bob', amount: 0.2, reason: '透支' }), /不足/);
    assert.throws(() => step(state, 'save-balance', balance()), /账户重复/);
});
test('invalid quantities, amounts, owners and missing reasons fail without touching source', () => {
    for (const quantity of [-1, 0.5, NaN, Infinity, 1000000001]) assert.throws(() => step(emptyState(), 'save-item', item({ quantity })), /整数/);
    for (const amount of [-1, NaN, Infinity, 0.1234567, 1000000001, '12']) assert.throws(() => step(emptyState(), 'save-balance', balance({ amount })), /数字/);
    assert.throws(() => step(emptyState(), 'save-item', item({ ownerId: 'missing' })), /持有人已不存在/);
    assert.throws(() => step(emptyState(), 'save-item', item({ reason: '' })), /操作原因/);
    assert.throws(() => step(emptyState(), 'save-item', item({ quantity: 0, equipped: true })), /零数量/);
});
test('sub-micro resource changes cannot round into zero-value transfers or ledger entries', () => {
    const state = step(emptyState(), 'save-balance', balance()), sourceId = state.balances[0].id, before = structuredClone(state);
    for (const tiny of [1e-13, 1e-7, 0.000000999999, 0.1000000000001]) {
        assert.throws(() => step(state, 'transfer-balance', { id: sourceId, toOwnerId: 'bob', amount: tiny, reason: '超出精度的转账' }), /六位小数/);
        for (const delta of [tiny, -tiny]) assert.throws(() => step(state, 'adjust-balance', { id: sourceId, delta, reason: '超出精度的收支' }), /六位小数/);
        assert.throws(() => step(emptyState(), 'save-balance', balance({ amount: tiny })), /六位小数/);
    }
    assert.deepEqual(state, before);
    const zero = step(emptyState(), 'save-balance', balance({ amount: 0 })); assert.equal(zero.balances[0].amount, 0);
    const micro = step(state, 'transfer-balance', { id: sourceId, toOwnerId: 'bob', amount: 0.000001, reason: '合法最小数量' });
    assert.equal(micro.balances[1].amount, 0.000001); assert.deepEqual(micro.ledger.at(-1).entries.map(entry => entry.delta), [-0.000001, 0.000001]);
});
test('orphan holdings remain visible and recoverable without assigning new stock to deleted characters', () => {
    const state = step(emptyState(), 'save-item', item()), sourceId = state.items[0].id;
    const orphanContext = { ...context(), ownerIds: ['bob'] };
    const edited = transition(state, 'save-item', { ...state.items[0], name: '保管中的急救包', reason: '保留旧持有人' }, orphanContext).state;
    assert.equal(edited.items[0].ownerId, 'alice');
    const moved = transition(edited, 'transfer-item', { id: sourceId, toOwnerId: 'bob', quantity: 5, reason: '继承遗留物品' }, orphanContext).state;
    assert.deepEqual(moved.items.map(value => [value.ownerId, value.quantity]), [['alice', 0], ['bob', 5]]);
    assert.throws(() => transition(state, 'save-item', item(), orphanContext), /持有人已不存在/);
    assert.throws(() => step(state, 'save-item', { ...state.items[0], ownerId: 'bob', reason: '绕过转移' }), /转移物品/);
});
test('branch snapshots isolate later consumption, candidate changes and restored facts', () => {
    const ctx = { chat: [msg('营地')], chatMetadata: {} };
    const first = change(emptyStore(), ctx.chat, 'save-item', item(), context()); ctx.chatMetadata[KEY] = first.store;
    const original = readInventory(ctx), sourceId = original.items[0].id;
    ctx.chat.push(msg('旧候选战斗'));
    ctx.chatMetadata[KEY] = change(readStore(ctx), ctx.chat, 'consume-item', { id: sourceId, quantity: 2, reason: '治疗' }, context()).store;
    assert.equal(readInventory(ctx).items[0].quantity, 3);
    ctx.chat[1] = msg('新候选潜行', 1);
    assert.equal(readInventory(ctx).items[0].quantity, 5);
    ctx.chatMetadata[KEY] = buildRestoreStore(ctx, { ...original, items: [{ ...original.items[0], quantity: 1 }] }, { id: createId(), at });
    assert.equal(readInventory(ctx).items[0].quantity, 1);
    assert.equal(ctx.chatMetadata[KEY].events.at(-1).op, 'restore');
    assert.deepEqual(readInventory(ctx).ledger, original.ledger);
    ctx.chat[1] = msg('旧候选战斗');
    assert.equal(readInventory(ctx).items[0].quantity, 3);
    ctx.chat.pop(); assert.equal(readInventory(ctx).items[0].quantity, 5);
});
test('restoring a valid full ledger preserves all saved entries exactly without spending ledger capacity', () => {
    const snapshot = step(emptyState(), 'save-item', item()), record = snapshot.ledger[0];
    snapshot.ledger = Array.from({ length: LIMITS.ledger }, (_, index) => ({ ...structuredClone(record), id: `full_ledger_${index}` }));
    const ctx = { chat: [msg('当前剧情位置')], chatMetadata: {} }, before = structuredClone(snapshot);
    ctx.chatMetadata[KEY] = buildRestoreStore(ctx, snapshot, { id: createId(), at, reason: '恢复已满账本的存档' });
    assert.equal(readInventory(ctx).ledger.length, LIMITS.ledger); assert.deepEqual(readInventory(ctx), before); assert.deepEqual(snapshot, before);
    assert.equal(ctx.chatMetadata[KEY].events.at(-1).op, 'restore'); assert.match(ctx.chatMetadata[KEY].events.at(-1).summary, /恢复已满账本的存档/);
});
test('unknown versions and corrupt records are preserved and block every write', () => {
    for (const raw of [null, { version: 99, events: [] }, { version: 1, events: [{}] }]) {
        const ctx = { chat: [], chatMetadata: { [KEY]: raw } }, before = structuredClone(ctx);
        assert.throws(() => readInventory(ctx)); assert.throws(() => buildRestoreStore(ctx, emptyState())); assert.deepEqual(ctx, before);
    }
    const state = step(emptyState(), 'save-item', item());
    state.ledger[0].entries[0].delta = -999;
    assert.throws(() => validateState(state), /增减与余额/);
});
test('valid extension fields survive mutations and source snapshots are not aliased', () => {
    const source = step(emptyState(), 'save-item', item()); source.custom = { saved: true }; source.items[0].custom = '原始字段';
    const result = step(source, 'equip-item', { id: source.items[0].id, equipped: true, reason: '装备' });
    assert.deepEqual(result.custom, source.custom); assert.equal(result.items[0].custom, '原始字段');
    result.custom.saved = false; assert.equal(source.custom.saved, true);
});
test('service preview changes nothing, confirms one shared operation and rejects duplicate confirm', async () => {
    const ctx = fixture(); let calls = 0; ctx.saveMetadata = async () => { calls++; };
    const service = createInventoryService(() => ctx, { createId, now: () => at });
    try {
        const preview = service.stage('save-item', item());
        assert.equal(ctx.chatMetadata[KEY], undefined); assert.equal(preview.state.items[0].quantity, 5);
        await service.confirm(); assert.equal(calls, 1); assert.equal(service.read().items[0].quantity, 5);
        await assert.rejects(service.confirm(), /没有待确认/); assert.equal(calls, 1);
    } finally { service.dispose(); }
});
test('failed save keeps confirmed transfer once and retry only persists the same ledger', async () => {
    const ctx = fixture(), service = createInventoryService(() => ctx, { createId, now: () => at });
    try {
        service.stage('save-balance', balance()); await service.confirm();
        let calls = 0; ctx.saveMetadata = async () => { calls++; if (calls === 1) throw Error('磁盘暂时不可用'); };
        service.stage('transfer-balance', { id: service.read().balances[0].id, toOwnerId: 'bob', amount: 2.5, reason: '分配金币' });
        await assert.rejects(service.confirm(), error => error.code === 'SAVE_FAILED' && error.committed);
        const committed = structuredClone(ctx.chatMetadata[KEY]);
        assert.equal(service.dirty(), true); assert.equal(service.preview(), null);
        assert.deepEqual(service.read().balances.map(value => value.amount), [10, 2.5]);
        assert.throws(() => service.stage('save-item', item()), /尚未保存/);
        await service.retrySave(); assert.equal(service.dirty(), false); assert.equal(calls, 2);
        assert.deepEqual(ctx.chatMetadata[KEY], committed);
    } finally { service.dispose(); }
});
test('chat switch and character deletion invalidate staged edits before any writes', async () => {
    let ctx = fixture(); const original = ctx;
    const service = createInventoryService(() => ctx, { createId, now: () => at });
    try {
        service.stage('save-item', item()); ctx = { ...fixture(), chatId: 'other-chat' };
        await assert.rejects(service.confirm(), /聊天或消息候选/); assert.equal(original.chatMetadata[KEY], undefined);
        ctx = original; service.discard(); const token = service.capture();
        ctx.chatMetadata[CHARACTERS_KEY] = restoreCharacters(ctx, { version: 1, characters: [] }, { id: createId(), at });
        assert.throws(() => service.stage('save-item', item(), token), /相关资料已变化/);
        assert.equal(ctx.chatMetadata[KEY], undefined);
    } finally { service.dispose(); }
});
test('save completion after chat switch never claims current chat success', async () => {
    let ctx = fixture(), release; const first = ctx;
    first.saveMetadata = () => new Promise(resolve => { release = resolve; });
    const service = createInventoryService(() => ctx, { createId, now: () => at });
    try {
        service.stage('save-item', item()); const saving = service.confirm();
        ctx = { ...fixture(), chatId: 'different-chat' }; release();
        await assert.rejects(saving, error => error.code === 'STALE_COMPLETION');
        assert.equal(ctx.chatMetadata[KEY], undefined); assert.equal(currentState(first.chatMetadata[KEY], first.chat).items[0].quantity, 5);
        ctx = first; first.saveMetadata = async () => {}; await service.retrySave(); assert.equal(service.read().ledger.length, 1);
    } finally { service.dispose(); }
});
