import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../apps/saves/adapters.js';
import { createSavesService } from '../apps/saves/service.js';
import { KEY as JOURNAL_KEY } from '../apps/journal/model.js';
import { KEY as INFORMATION_KEY } from '../apps/information/model.js';
import { registerMapRuntime } from '../apps/map/src/integrations/runtime.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { emptyState as emptyInventory, transition as inventoryChange } from '../apps/inventory/model.js';

const at = '2026-09-23T00:00:00.000Z';
function fixture() {
    let id = 0;
    const ctx = { chat: [], chatMetadata: {}, characterId: 0, characters: [{ avatar: 'review-character.png' }], getCurrentChatId: () => 'review-chat', saveMetadata: async () => {} };
    const service = createSavesService(() => ctx, { createId: () => `review_${++id}`, now: () => at });
    return { ctx, service };
}

for (const [label, key] of [['journal', JOURNAL_KEY], ['information', INFORMATION_KEY]]) {
    test(`cross-app restore refuses present null ${label} data instead of treating it as absent`, async () => {
        const t = fixture();
        try {
            t.service.stageSave({ name: '资料尚未建立时的存档' }); await t.service.confirm();
            const saved = t.service.read().saves[0]; t.ctx.chatMetadata[key] = null;
            const before = structuredClone(t.ctx.chatMetadata);
            assert.throws(() => materialize(t.ctx), /无效|损坏|不兼容|格式/);
            assert.throws(() => t.service.stageRestore(saved.id), /无效|损坏|不兼容|格式/);
            assert.deepEqual(t.ctx.chatMetadata, before);
        } finally { t.service.dispose(); }
    });
}

test('cross-app restore refuses map draft edits both before preview and before confirmation', async () => {
    const t = fixture(); let dirty = false;
    t.ctx.chatMetadata.dynamicMapV1 = { updatedAt: 1, document: createDemoDocument() };
    const unregister = registerMapRuntime({ context: () => t.ctx, persistence: { ensureActive() {}, saving: () => false }, draft: { status: () => ({ dirty }) }, store: { snapshot: () => t.ctx.chatMetadata.dynamicMapV1.document } });
    try {
        t.service.stageSave({ name: '地图存档' }); await t.service.confirm();
        const id = t.service.read().saves[0].id, before = structuredClone(t.ctx.chatMetadata);
        dirty = true; assert.throws(() => t.service.stageRestore(id), /未保存|草稿/);
        dirty = false; t.service.stageRestore(id); dirty = true;
        await assert.rejects(async () => t.service.confirm(), /未保存|草稿/);
        assert.deepEqual(t.ctx.chatMetadata, before);
    } finally { unregister(); t.service.dispose(); }
});

test('resource transfers and adjustments reject positive values smaller than the supported precision', () => {
    const state = emptyInventory(); state.balances.push({ id: 'account', ownerId: 'alice', name: '金币', unit: '枚', amount: 10, notes: '' });
    const before = structuredClone(state); let id = 0;
    const context = { ownerIds: ['alice', 'bob'], createId: () => `money_${++id}`, at };
    assert.throws(() => inventoryChange(state, 'transfer-balance', { id: 'account', toOwnerId: 'bob', amount: 1e-13, reason: '精度不足的转账' }, context), /大于零|六位|精度|非零|数字/);
    assert.throws(() => inventoryChange(state, 'adjust-balance', { id: 'account', delta: 1e-13, reason: '精度不足的收入' }, context), /大于零|六位|精度|非零|数字/);
    assert.deepEqual(state, before);
});
