import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createStoryStorage } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { getReference } from '../apps/shared/story-message-refs.js';
import { saveChatMetadata } from '../apps/shared/chat-save.js';

const clone = value => structuredClone(value);
function fixture() {
    const handlers = new Map();
    const nodes = new Map(), store = {
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    };
    const graph = createStoryStateGraph(store);
    let saves = 0, fullSaves = 0, nativeCalls = 0;
    const ctx = {
        eventTypes: { MESSAGE_SWIPED: 'swiped' }, eventSource: { on(name,fn){handlers.set(name,fn);}, removeListener(name){handlers.delete(name);} },
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
    return { ctx, runtime, story, graph, nodes, reports, handlers,
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


test('TT empty swipe event restores previous floor before generation and archives only completed candidate', async()=>{
 const f=fixture();
 try{
  await f.runtime.migrate();
  f.ctx.chat.push({name:'User',mes:'选择回复选项后发送',is_user:true});await f.runtime.prepareGeneration();
  const tail={name:'NPC',mes:'原回复',swipes:['原回复'],swipe_id:0,swipe_info:[{extra:{}}]};f.ctx.chat.push(tail);
  f.ctx.chatMetadata.variables.状态栏=JSON.stringify({项目:{世界:{时间:9}}});await saveChatMetadata(f.ctx);
  const old=clone(tail.swipe_info[0]),count=f.nodes.size;
  tail.swipe_id=1; // TT clears message data and emits BEFORE starting Generate.
  tail.mes='';
  await f.handlers.get('swiped')(2);
  assert.equal(f.runtime.ready(),true);
  assert.equal(f.runtime.status().restoreError,'');
  assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间,1);
  assert.equal(f.nodes.size,count);assert.deepEqual(tail.swipe_info[0],old);
  await f.runtime.prepareGeneration('swipe');
  tail.mes='新回复';tail.swipes.push('新回复');tail.swipe_info.push({extra:{}});
  f.ctx.chatMetadata.variables.状态栏=JSON.stringify({项目:{世界:{时间:4}}});await saveChatMetadata(f.ctx);
  assert.notEqual(getReference(tail).stateId,old.extra.amin_story_v2.stateId);
  assert.deepEqual(tail.swipe_info[0],old);
  tail.swipe_id=0;tail.mes=tail.swipes[0];tail.extra=clone(old.extra);
  await f.handlers.get('swiped')(2);
  assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间,9);
 }finally{f.runtime.destroy();}
});
test('mismatched existing candidate still fails restoration instead of silently using previous floor',async()=>{
 const f=fixture();try{
  await f.runtime.migrate();f.ctx.chat.push({name:'User',mes:'继续',is_user:true});await f.runtime.prepareGeneration();
  const tail={name:'NPC',mes:'已保存',swipes:['已保存'],swipe_id:0,swipe_info:[{extra:{}}]};f.ctx.chat.push(tail);await saveChatMetadata(f.ctx);
  tail.mes='与已有候选不一致';await f.handlers.get('swiped')(2);
  assert.equal(f.runtime.ready(),false);assert.match(f.runtime.status().restoreError,/候选尚未保存完整/);
 }finally{f.runtime.destroy();}
});
