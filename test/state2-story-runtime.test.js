import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createStoryStorage } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { getReference } from '../apps/shared/story-message-refs.js';
import { saveChatMetadata } from '../apps/shared/chat-save.js';

const clone = value => structuredClone(value);
function fixture() {
    const nodes = new Map(), store = {
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    };
    const graph = createStoryStateGraph(store);
    let saves = 0, fullSaves = 0, nativeCalls = 0;
    const ctx = {
        chatId: 'new-chat', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'npc.png' }],
        chat: [{ name: 'NPC', mes: '开场', is_user: false }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chatMetadata: { integrity: 'ready', variables: { 状态栏: JSON.stringify({ 项目: { 世界: { 时间: 1 } } }) }, LWB_RULES_V2: {} },
        async saveMetadata() { saves++; },
        async saveChat() { fullSaves++; },
        saveMetadataDebounced() {},
    };
    const host = { LWB_StateV2: { applyText() { nativeCalls++; throw Error('duplicate update'); } } };
    const story = createStoryStorage(() => ctx, { graph, restoreState: async (_floor, snapshot) => {
        ctx.chatMetadata.variables = clone(snapshot.variables);
        ctx.chatMetadata.LWB_RULES_V2 = clone(snapshot.rules);
        return { restored: true, stale: false };
    } });
    const reports = [];
    const runtime = createState2Runtime(() => ctx, { host, storyStorage: story, interval: 0,
        restoreNative: async () => ({ restored: true, stale: false }), report: message => reports.push(message) });
    return { ctx, runtime, story, graph, nodes, reports,
        get saves() { return saves; }, get fullSaves() { return fullSaves; }, get nativeCalls() { return nativeCalls; } };
}

test('runtime migration enables external story and saves the first short message ref', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        assert.equal(f.runtime.storyStatus().enabled, true);
        assert.ok(getReference(f.ctx.chat[0]));
        assert.equal(f.nodes.size, 1);
        assert.ok(f.fullSaves >= 1);
        assert.equal(f.nativeCalls, 0);
    } finally { f.runtime.destroy(); }
});

test('runtime generation captures user floor once and branch hydration restores external snapshot', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        const old = JSON.parse(f.ctx.chatMetadata.variables.状态栏);
        assert.equal(old.项目.世界.时间, 1);
        f.ctx.chat.push({ name: 'User', mes: '下一步', is_user: true });
        await f.runtime.prepareGeneration();
        assert.ok(getReference(f.ctx.chat[1]));
        assert.equal((await f.runtime.readStoryFloor(1)).variables.状态栏, f.ctx.chatMetadata.variables.状态栏);

        f.ctx.chat.push({ name: 'NPC', mes: '未来' });
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 9 } } });
        await f.runtime.prepareGeneration();
        // A new assistant floor is archived by the message save path.
        assert.ok(getReference(f.ctx.chat[2]));
        const branchMetadata = clone(f.ctx.chatMetadata);
        f.ctx.chat.pop();
        f.ctx.chatMetadata = branchMetadata;
        f.ctx.chatId = 'branch';
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), true);
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间, 1);
        assert.equal(f.nativeCalls, 0);
    } finally { f.runtime.destroy(); }
});

test('missing external node makes branch runtime unready and generation fails closed', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        const id = getReference(f.ctx.chat[0]).stateId;
        f.nodes.delete(id);
        f.ctx.chatMetadata = clone(f.ctx.chatMetadata);
        f.ctx.chatId = 'branch';
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), false);
        await assert.rejects(f.runtime.prepareGeneration(), /恢复失败|未恢复|找不到/);
        assert.ok(f.reports.some(message => /找不到/.test(message)));
    } finally { f.runtime.destroy(); }
});

test('new candidate starts from the preceding floor without rewriting the old candidate ref', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        f.ctx.chat.push({ name: 'User', mes: '下一步', is_user: true });
        await f.runtime.prepareGeneration();
        f.ctx.chat.push({ name: 'NPC', mes: '旧候选', swipes: ['旧候选'], swipe_id: 0, swipe_info: [{ extra: {} }] });
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 9 } } });
        await saveChatMetadata(f.ctx);
        const previous = getReference(f.ctx.chat[2]);
        await f.runtime.prepareGeneration('swipe');
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间, 1);
        assert.deepEqual(getReference(f.ctx.chat[2]), previous);
        assert.equal(f.runtime.ready(), true);
        const before = f.fullSaves;
        await f.runtime.reconcile();
        assert.deepEqual(getReference(f.ctx.chat[2]), previous);
        assert.equal(f.fullSaves, before);
    } finally { f.runtime.destroy(); }
});

test('late native update is archived once and unchanged reconciliations do not save', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        await f.runtime.reconcile();
        const initialRef = getReference(f.ctx.chat[0]).stateId;
        const savesBefore = f.fullSaves;
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 4 } } });
        await f.runtime.reconcile();
        const updatedRef = getReference(f.ctx.chat[0]).stateId;
        assert.notEqual(updatedRef, initialRef);
        assert.equal(f.fullSaves, savesBefore + 1);
        await f.runtime.reconcile();
        await f.runtime.reconcile();
        assert.equal(getReference(f.ctx.chat[0]).stateId, updatedRef);
        assert.equal(f.fullSaves, savesBefore + 1);
    } finally { f.runtime.destroy(); }
});
