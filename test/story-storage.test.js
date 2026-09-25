import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { getReference, setReference } from '../apps/shared/story-message-refs.js';
import { createStoryStorage, STORY_STORAGE_KEY } from '../apps/state2/story-storage.js';
import { ROOTS } from '../apps/state2/storage.js';

const clone = value => structuredClone(value);
const managed = new Set([...Object.values(ROOTS), '状态栏', '势力资料']);
function fixture() {
    const nodes = new Map(), store = {
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    };
    const graph = createStoryStateGraph(store);
    let ctx = {
        chatId: 'new-chat', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'npc.png' }],
        chat: [{ name: 'NPC', mes: '开场', is_user: false }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chatMetadata: { integrity: 'ready', variables: { [ROOTS.characters]: JSON.stringify({ names: [{ id: 'a', name: '甲' }], notes: 'Y'.repeat(10_000) }), 状态栏: JSON.stringify({ 日程: 1 }), unrelated: 'X'.repeat(200_000) }, LWB_RULES_V2: { 'AminOS人物.x': 'allow', unrelated: 'keep' } },
    };
    let restores = 0;
    const service = createStoryStorage(() => ctx, { graph, restoreState: async (index, snapshot) => {
        restores++;
        for (const root of managed) {
            if (Object.hasOwn(snapshot.variables, root)) ctx.chatMetadata.variables[root] = clone(snapshot.variables[root]);
            else delete ctx.chatMetadata.variables[root];
        }
        for (const path of Object.keys(ctx.chatMetadata.LWB_RULES_V2)) {
            if (managed.has(path.split(/[.\[]/, 1)[0])) delete ctx.chatMetadata.LWB_RULES_V2[path];
        }
        Object.assign(ctx.chatMetadata.LWB_RULES_V2, clone(snapshot.rules));
        return { restored: true, stale: false };
    } });
    return { get ctx() { return ctx; }, set ctx(next) { ctx = next; }, nodes, graph, service, get restores() { return restores; } };
}

test('new chat stores one baseline and compact per-message refs; JSON-string roots use field deltas', async () => {
    const f = fixture();
    const enabled = await f.service.enable();
    assert.equal(enabled.changed, true);
    assert.equal(f.ctx.chatMetadata[STORY_STORAGE_KEY].baseStateId, enabled.baseStateId);
    assert.ok(getReference(f.ctx.chat[0]));
    assert.doesNotMatch(JSON.stringify(f.ctx.chat[0].extra), /开场|日程|names/);
    assert.deepEqual(await f.service.capture(), { changed: false, stateId: enabled.baseStateId });

    f.ctx.chat.push({ name: 'NPC', mes: '第二轮', is_user: false });
    const people = JSON.parse(f.ctx.chatMetadata.variables[ROOTS.characters]);
    people.names[0].name = '乙';
    f.ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(people);
    const added = await f.service.capture();
    assert.equal(added.changed, true);
    assert.equal(f.nodes.get(added.stateId).kind, 'delta');
    assert.ok(JSON.stringify([...f.nodes.values()]).length < 20_000);
    assert.equal(f.nodes.get(added.stateId).changes.some(change => change.path.join('.') === 'variables.AminOS人物.names.0.name'), true);
    assert.equal(Object.hasOwn((await f.service.readFloor(1)).variables, 'unrelated'), false);
    assert.equal(Object.hasOwn((await f.service.readFloor(1)).rules, 'unrelated'), false);
    assert.equal(JSON.parse((await f.service.readFloor(0)).variables[ROOTS.characters]).names[0].name, '甲');
    assert.equal(JSON.parse((await f.service.readFloor(1)).variables[ROOTS.characters]).names[0].name, '乙');
    assert.equal((await f.service.capture()).changed, false);
});

test('branch floor restores its own snapshot and does not use future values', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'NPC', mes: '未来' });
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 9 });
    await f.service.capture();
    const branch = { ...f.ctx, chat: clone(f.ctx.chat), chatMetadata: clone(f.ctx.chatMetadata) };
    branch.chatId = 'branch-from-first';
    branch.chat.pop();
    f.ctx = branch;
    f.ctx.chatMetadata.variables.unrelated = 99;
    const historical = await f.service.readFloor(0);
    assert.equal(JSON.parse(historical.variables.状态栏).日程, 1);
    await f.service.restoreFloor(0);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).日程, 1);
    assert.equal(f.ctx.chatMetadata.variables.unrelated, 99);
    assert.equal(f.ctx.chatMetadata.LWB_RULES_V2.unrelated, 'keep');
    assert.equal(f.restores, 1);
    await assert.rejects(f.service.restoreFloor(-1), /末尾/);
});

test('new swipe restores the preceding floor while retaining the previous candidate reference', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'User', mes: '继续', is_user: true });
    await f.service.capture();
    f.ctx.chat.push({ name: 'NPC', mes: '旧候选', swipes: ['旧候选'], swipe_id: 0, swipe_info: [{ extra: {} }] });
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 6 });
    const old = await f.service.capture();
    const oldRef = getReference(f.ctx.chat[2]);
    let received;
    const service = createStoryStorage(() => f.ctx, { graph: f.graph, restoreState: async (floor, snapshot, options) => {
        received = { floor, snapshot, options };
        return { restored: true, stale: false };
    } });
    const result = await service.restoreBeforeCandidate('swipe');
    assert.equal(result.stateId, getReference(f.ctx.chat[1]).stateId);
    assert.equal(received.floor, 1);
    assert.equal(received.options.forGeneration, true);
    assert.equal(JSON.parse(received.snapshot.variables.状态栏).日程, 1);
    assert.equal(getReference(f.ctx.chat[2]).stateId, old.stateId);
    assert.deepEqual(getReference(f.ctx.chat[2]), oldRef);
});

test('edited ancestor or absent external file blocks history and never falls back to current variables', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'NPC', mes: '第二轮' });
    await f.service.capture();
    const secondId = getReference(f.ctx.chat[1]).stateId;
    f.ctx.chat[0].mes = '改写开场';
    await assert.rejects(f.service.readFloor(1), /变化|失效/);
    f.ctx.chat[0].mes = '开场';
    f.nodes.delete(secondId);
    await assert.rejects(f.service.readFloor(1), /找不到|缺失/);
});

test('each swipe owns a separate state reference and export includes both', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'NPC', mes: '第一候选', swipes: ['第一候选', '第二候选'], swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }] });
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 2 });
    const first = await f.service.capture();
    f.ctx.chat[1].swipe_id = 1;
    f.ctx.chat[1].mes = '第二候选';
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 3 });
    const second = await f.service.capture();
    assert.notEqual(first.stateId, second.stateId);
    const exportBundle = await f.service.exportStory();
    assert.ok(exportBundle.graph.nodes[first.stateId]);
    assert.ok(exportBundle.graph.nodes[second.stateId]);
    f.ctx.chat[1].swipe_id = 0;
    f.ctx.chat[1].mes = '第一候选';
    assert.equal(JSON.parse((await f.service.readFloor(1)).variables.状态栏).日程, 2);
});

test('manual backup ids remain in export after a floor ref moves to a newer state', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 2 });
    const backup = await f.service.capture();
    f.ctx.chatMetadata[STORY_STORAGE_KEY].backups.push({ stateId: backup.stateId, label: '修改前', at: 123 });
    f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 3 });
    await f.service.capture();
    assert.equal(JSON.parse((await f.service.readState(backup.stateId)).variables.状态栏).日程, 2);
    assert.ok((await f.service.exportStory()).graph.nodes[backup.stateId]);
    f.ctx.chatMetadata[STORY_STORAGE_KEY].backups[0].stateId = 'bad';
    await assert.rejects(f.service.exportStory(), /备份目录/);
});

test('late graph write cannot attach a reference after chat switch', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'NPC', mes: '等待存储' });
    let release;
    const delayedGraph = {
        ...f.graph,
        async save(...args) {
            await new Promise(resolve => { release = resolve; });
            return f.graph.save(...args);
        },
    };
    const service = createStoryStorage(() => f.ctx, { graph: delayedGraph });
    const pending = service.capture();
    await new Promise(resolve => setImmediate(resolve));
    f.ctx.chatId = 'another-chat';
    release();
    await assert.rejects(pending, /变化/);
    assert.equal(getReference(f.ctx.chat[1]), null);
});

test('late graph write cannot overwrite a reference changed by another capture', async () => {
    const f = fixture();
    await f.service.enable();
    f.ctx.chat.push({ name: 'NPC', mes: '并发状态' });
    let release;
    const delayedGraph = { ...f.graph, async save(...args) {
        await new Promise(resolve => { release = resolve; });
        return f.graph.save(...args);
    } };
    const service = createStoryStorage(() => f.ctx, { graph: delayedGraph });
    const pending = service.capture();
    await new Promise(resolve => setImmediate(resolve));
    const unrelated = f.ctx.chatMetadata[STORY_STORAGE_KEY].baseStateId;
    setReference(f.ctx.chat[1], unrelated, { parentStateId: unrelated });
    release();
    await assert.rejects(pending, /变化/);
    assert.equal(getReference(f.ctx.chat[1]).stateId, unrelated);
});

test('existing multi-floor chat must not invent a past baseline', async () => {
    const f = fixture();
    f.ctx.chat.push({ name: 'NPC', mes: '已有历史' });
    await assert.rejects(f.service.enable(), /新聊天/);
    assert.equal(f.nodes.size, 0);
});


test('explicit reference repair previews existing states without overwriting them with future variables',async()=>{
 const f=fixture();await f.service.enable();
 f.ctx.chat.push({name:'NPC',mes:'旧正文'});await f.service.capture();const saved=getReference(f.ctx.chat[1]).stateId;
 f.ctx.chat[1].mes='宿主完成后的正文';const before=JSON.stringify(f.ctx);
 const plan=await f.service.inspectReferences();assert.equal(plan.repairs.length,1);assert.equal(plan.repairs[0].index,1);
 assert.equal(JSON.stringify(f.ctx),before);assert.equal(plan.repairs[0].stateId,saved);
 const result=await f.service.repairReferences(plan);assert.equal(result.repaired,1);assert.equal(getReference(f.ctx.chat[1]).stateId,saved);
 assert.deepEqual((await f.service.readFloor(1)).variables,(await f.service.readFloor(0)).variables);
});
test('repair plans reject changes made after preview',async()=>{
 const f=fixture();await f.service.enable();f.ctx.chat[0].mes='changed';const plan=await f.service.inspectReferences();
 f.ctx.chat[0].mes='changed again';await assert.rejects(f.service.repairReferences(plan),/变化/);
});


test('failed persistence can roll back reference rebinding without touching saved state',async()=>{
 const f=fixture();await f.service.enable();const original=structuredClone(f.ctx.chat[0].extra);f.ctx.chat[0].mes='changed';
 const plan=await f.service.inspectReferences();const result=await f.service.repairReferences(plan);result.rollback();assert.deepEqual(f.ctx.chat[0].extra,original);
 assert.equal((await f.service.inspectReferences()).repairs.length,1);
});
