import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createStoryStorage, STORY_STORAGE_KEY } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { registerChatSavePreparation, saveChatMetadata } from '../apps/shared/chat-save.js';

const clone = value => structuredClone(value);
const variables = time => JSON.stringify({ 项目: { 世界: { 时间: time } } });
async function fixture(t, { before, after, legacy = false } = {}) {
    let active = false, captures = 0, saves = 0, failSave = false;
    const nodes = new Map();
    const graph = createStoryStateGraph({
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    });
    const ctx = {
        chatId: 'test-chat', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'test.png' }],
        chat: [{ name: 'NPC', mes: '开场', swipes: ['开场', '另一候选'], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }] }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chatMetadata: { integrity: 'ready', variables: { 状态栏: variables(1) }, LWB_RULES_V2: {} },
        async saveChat() { saves++; if (failSave) throw Error('disk busy'); },
        async saveMetadata() { saves++; if (failSave) throw Error('disk busy'); },
    };
    if (before) t.after(registerChatSavePreparation(() => active && before(ctx)));
    const story = createStoryStorage(() => ctx, { graph, restoreState: async (_floor, state) => {
        ctx.chatMetadata.variables = clone(state.variables);
        ctx.chatMetadata.LWB_RULES_V2 = clone(state.rules);
        return { restored: true, stale: false };
    } });
    const realCapture = story.capture;
    story.capture = async options => {
        captures++;
        return realCapture(legacy ? { ...options, saveReceipt: false } : options);
    };
    if (legacy) delete story.consumeCaptureReceipt;
    const runtime = createState2Runtime(() => ctx, { storyStorage: story, interval: 0,
        host: { LWB_StateV2: { applyText() { throw Error('must not execute model updates'); } } },
        restoreNative: async () => ({ restored: true, stale: false }),
    });
    t.after(() => runtime.destroy());
    if (after) t.after(registerChatSavePreparation(() => active && after(ctx)));
    await runtime.migrate();
    await runtime.reconcile();
    captures = 0; saves = 0; active = true;
    return { ctx, story, runtime, nodes, graph,
        get captures() { return captures; }, get saves() { return saves; },
        set failSave(value) { failSave = value; }, set active(value) { active = value; },
        change() { ctx.chatMetadata.variables.状态栏 = variables(2); },
    };
}

test('automatic archive reuses one verified capture and does not persist its receipt', async t => {
    const f = await fixture(t); f.change();
    await f.runtime.reconcile();
    assert.equal(f.captures, 1); assert.equal(f.saves, 1);
    assert.equal((await f.story.readFloor(0)).variables.状态栏, variables(2));
    assert.doesNotMatch(JSON.stringify([f.ctx.chatMetadata, f.ctx.chat, [...f.nodes.values()]]), /receipt/);
});

test('legacy story adapters without receipts retain the ordinary preparation path', async t => {
    const f = await fixture(t, { legacy: true }); f.change();
    await f.runtime.reconcile();
    assert.equal(f.captures, 2); assert.equal(f.saves, 1);
});

for (const [name, mutate, verify] of [
    ['variable', ctx => { ctx.chatMetadata.variables.状态栏 = variables(3); }, state => assert.equal(state.variables.状态栏, variables(3))],
    ['rule', ctx => { ctx.chatMetadata.LWB_RULES_V2['状态栏.项目.世界.时间'] = 'locked'; }, state => assert.equal(state.rules['状态栏.项目.世界.时间'], 'locked')],
]) test(`an earlier preparation changing a ${name} triggers a fresh capture`, async t => {
    const f = await fixture(t, { before: mutate }); f.change();
    await f.runtime.reconcile();
    assert.equal(f.captures, 2); assert.equal(f.saves, 1);
    verify(await f.story.readFloor(0));
});

for (const [name, mutate] of [
    ['chat identity', ctx => { ctx.chatId = 'other-chat'; }],
    ['metadata identity', ctx => { ctx.chatMetadata = clone(ctx.chatMetadata); }],
    ['integrity', ctx => { ctx.chatMetadata.integrity = 'replacement'; }],
    ['selected Swipe', ctx => { ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = ctx.chat[0].swipes[1]; }],
    ['unselected Swipe body', ctx => { ctx.chat[0].swipes[1] = 'changed'; }],
    ['index reference', ctx => { ctx.chatMetadata[STORY_STORAGE_KEY].indexId = ctx.chatMetadata[STORY_STORAGE_KEY].baseStateId; }],
]) test(`an earlier preparation changing ${name} blocks the host save`, async t => {
    const f = await fixture(t, { before: mutate }); f.change();
    const result = await f.runtime.reconcile();
    assert.equal(result.error.code, 'STORY_CHAT_CHANGED');
    assert.equal(f.captures, 1); assert.equal(f.saves, 0);
});

test('a later preparation changing variables fails closed and the next save captures the new state', async t => {
    const f = await fixture(t, { after: ctx => { ctx.chatMetadata.variables.状态栏 = variables(4); } }); f.change();
    const result = await f.runtime.reconcile();
    assert.equal(result.error.code, 'STORY_STATE_CHANGED'); assert.equal(f.saves, 0);
    f.active = false;
    await saveChatMetadata(f.ctx);
    assert.equal(f.captures, 2); assert.equal(f.saves, 1);
    assert.equal((await f.story.readFloor(0)).variables.状态栏, variables(4));
});

test('a later preparation changing a Swipe is checked immediately before the host save', async t => {
    const f = await fixture(t, { after: ctx => { ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = ctx.chat[0].swipes[1]; } }); f.change();
    const result = await f.runtime.reconcile();
    assert.equal(result.error.code, 'STORY_CHAT_CHANGED'); assert.equal(f.saves, 0);
});

test('a failed host save does not reuse its old receipt on retry', async t => {
    const f = await fixture(t); f.change(); f.failSave = true;
    assert.match((await f.runtime.reconcile()).error.message, /disk busy/);
    assert.equal(f.captures, 1); assert.equal(f.saves, 1);
    f.failSave = false;
    await saveChatMetadata(f.ctx);
    assert.equal(f.captures, 2); assert.equal(f.saves, 2);
});

test('generation retries a pending archive host save even when its state and index are unchanged', async t => {
    const f = await fixture(t); f.change(); f.failSave = true;
    assert.match((await f.runtime.reconcile()).error.message, /disk busy/);
    const indexId = f.ctx.chatMetadata[STORY_STORAGE_KEY].indexId;
    f.failSave = false;
    await f.runtime.reconcile(); await f.runtime.reconcile();
    assert.equal(f.captures, 1); assert.equal(f.saves, 1); // No timer retry loop.
    await f.runtime.prepareGeneration('normal');
    assert.equal(f.captures, 2); assert.equal(f.saves, 2);
    assert.equal(f.ctx.chatMetadata[STORY_STORAGE_KEY].indexId, indexId);
    await f.runtime.prepareGeneration('normal');
    assert.equal(f.captures, 3); assert.equal(f.saves, 2);
});

for (const sameMetadata of [false, true]) test(`a pending archive save cannot transfer to a different chat (${sameMetadata ? 'reused' : 'new'} metadata)`, async t => {
    const f = await fixture(t); f.change(); f.failSave = true;
    await f.runtime.reconcile(); f.failSave = false;
    if (!sameMetadata) f.ctx.chatMetadata = clone(f.ctx.chatMetadata);
    f.ctx.chatId = 'different-chat';
    await f.runtime.restoreChat();
    const saved = f.saves;
    await f.runtime.prepareGeneration('normal');
    assert.equal(f.saves, saved);
});

for (const swipe of [0, 1]) test(`Swipe ${swipe} changing while external files are written cannot receive a capture receipt`, async t => {
    const f = await fixture(t); f.change();
    const before = f.ctx.chatMetadata[STORY_STORAGE_KEY].indexId, save = f.graph.save;
    let changed = false;
    f.graph.save = async (...args) => {
        const id = await save(...args);
        if (!changed) { changed = true; f.ctx.chat[0].swipes[swipe] = 'candidate has not synchronized'; }
        return id;
    };
    await assert.rejects(f.story.capture({ saveReceipt: true }), error => ['STORY_CHAT_CHANGED', 'INCOMPLETE_CANDIDATE'].includes(error.code));
    assert.equal(f.ctx.chatMetadata[STORY_STORAGE_KEY].indexId, before);
});

test('capture receipts are one-use and unchanged default capture results keep their original shape', async t => {
    const f = await fixture(t);
    const ordinary = await f.story.capture();
    assert.deepEqual(Object.keys(ordinary).sort(), ['changed', 'stateId']);
    const { receipt } = await f.story.capture({ saveReceipt: true });
    const check = f.story.consumeCaptureReceipt(receipt, f.ctx);
    assert.equal(typeof check, 'function'); check();
    assert.equal(f.story.consumeCaptureReceipt(receipt, f.ctx), null);
    f.ctx.chatMetadata.LWB_RULES_V2['状态栏.项目.世界.时间'] = 'changed after prepare';
    assert.throws(check, { code: 'STORY_STATE_CHANGED' });
});
