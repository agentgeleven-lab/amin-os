import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationService } from '../apps/generation/service.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { KEY, readStore, putAutoDraft, currentDrafts, sourceFromRange } from '../apps/journal/model.js';

const source = { text: '{}', provenance: { chat: { start: 0, end: 0, indices: [0] } } };
const request = { modules: ['journal'], mode: 'create', sources: { includeChat: true, start: 0, end: 0 } };
const chronicle = { module: 'journal', action: 'draft_chronicle', target: 'draft1', data: { title: '新标题', body: '新正文', sourceStart: 0, sourceEnd: 0 }, reason: '所选楼层' };
const fact = { module: 'journal', action: 'set_fact', target: 'fact1', data: { title: '事实', body: '正文', sourceStart: 0, sourceEnd: 0 }, reason: '所选楼层' };
function fixture(changes, collectSources = async () => structuredClone(source)) {
    let saves = 0;
    const ctx = { chat: [{ mes: '剧情文本', name: '角色', extra: {} }], characterId: 0, getCurrentChatId: () => 'invariants', chatMetadata: {}, saveMetadata: async () => { saves++; } };
    const api = createGenerationService(() => ctx, { collectSources, ai: { capture: () => ({}), generate: async () => JSON.stringify({ version: 1, changes }) } });
    return { ctx, api, get saves() { return saves; } };
}
function seedDraft(ctx, body = '旧正文', operation = 'seed') {
    ctx.chatMetadata[KEY] = putAutoDraft(readStore(ctx), ctx.chat, { id: 'draft1', title: '旧标题', body, sources: sourceFromRange(ctx.chat, 0, 0) }, operation, '2026-09-23T00:00:00.000Z');
}

for (const mode of ['create', 'supplement']) test(`${mode} cannot overwrite an existing ready chronicle draft`, async () => {
    const f = fixture([chronicle]); seedDraft(f.ctx); const before = structuredClone(f.ctx.chatMetadata);
    await assert.rejects(f.api.generate({ ...request, mode }), /不能修改|不能覆盖/);
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(f.saves, 0); f.api.dispose();
});

test('editing a ready chronicle in another window after generation invalidates confirmation', async () => {
    const f = fixture([fact]); seedDraft(f.ctx);
    await f.api.generate(request); f.api.stage([fact]);
    seedDraft(f.ctx, '其他窗口的新正文', 'external-edit');
    const before = structuredClone(f.ctx.chatMetadata);
    await assert.rejects(f.api.confirm(), /已变化/);
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(f.saves, 0);
    assert.equal(currentDrafts(readStore(f.ctx), f.ctx.chat)[0].body, '其他窗口的新正文'); f.api.dispose();
});

test('cancel during confirmation source reread prevents all persistence even if reader ignores abort', async () => {
    let reads = 0, releaseRead, signal;
    let enterRead; const entered = new Promise(resolve => { enterRead = resolve; });
    const f = fixture([fact], async (_ctx, _sources, options) => {
        if (++reads === 2) { signal = options.signal; enterRead(); await new Promise(resolve => { releaseRead = resolve; }); }
        return structuredClone(source);
    });
    await f.api.generate(request); f.api.stage([fact]); const before = structuredClone(f.ctx.chatMetadata);
    const pending = f.api.confirm(); await entered; f.api.cancel();
    assert.equal(signal.aborted, true); releaseRead();
    await assert.rejects(pending, /已取消/);
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(f.saves, 0); assert.equal(f.api.dirty(), false); f.api.dispose();
});

test('new ID does not allow duplicate existing character name and kind', async () => {
    const duplicate = { module: 'characters', action: 'create-character', target: 'new-id', data: { name: 'ＡＬＩＣＥ', kind: 'npc' }, reason: '角色资料' };
    const f = fixture([duplicate]);
    const result = characters.apply(f.ctx, { ...duplicate, target: 'existing-id', data: { name: 'Alice', kind: 'npc' } }, { operationId: 'seed_character', now: '2026-09-23T00:00:00.000Z' });
    for (const patch of result.patches) f.ctx.chatMetadata[patch.path[0]] = patch.value;
    const before = structuredClone(f.ctx.chatMetadata);
    await assert.rejects(f.api.generate({ modules: ['characters'], instruction: '建立人物', mode: 'create' }), /同名同类型/);
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(f.saves, 0); f.api.dispose();
});
