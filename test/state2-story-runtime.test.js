import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createStoryStorage } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { candidateId, indexedState, STORY_MESSAGE_ID, STORY_CANDIDATE_ID } from '../apps/shared/story-chat-index.js';
async function reference(f, message) {
    if (!message[STORY_MESSAGE_ID]) return null;
    const index = await f.graph.load(f.ctx.chatMetadata.amin_os_story_storage_v2.indexId);
    const stateId = indexedState(index, message);
    return stateId ? { stateId } : null;
}
import { registerChatSavePreparation, saveChatMetadata } from '../apps/shared/chat-save.js';

const clone = value => structuredClone(value);
function fixture() {
    const handlers = new Map();
    const nodes = new Map(), store = {
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    };
    const graph = createStoryStateGraph(store);
    let saves = 0, fullSaves = 0, nativeCalls = 0;
    let ctx = {
        eventTypes: { CHAT_CHANGED:'chat',MESSAGE_SWIPED: 'swiped',GENERATION_AFTER_COMMANDS:'generating',GENERATION_ENDED:'ended' }, eventSource: { on(name,fn){handlers.set(name,fn);}, removeListener(name){handlers.delete(name);} },
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
    return { get ctx() { return ctx; }, set ctx(next) { ctx = next; }, runtime, story, graph, nodes, reports, handlers,
        get saves() { return saves; }, get fullSaves() { return fullSaves; }, get nativeCalls() { return nativeCalls; } };
}

test('runtime migration enables external story and saves the first short message ref', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        assert.equal(f.runtime.storyStatus().enabled, true);
        assert.ok((await reference(f, f.ctx.chat[0])));
        assert.equal(f.nodes.size, 2);
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
        assert.ok((await reference(f, f.ctx.chat[1])));
        assert.equal((await f.runtime.readStoryFloor(1)).variables.状态栏, f.ctx.chatMetadata.variables.状态栏);

        f.ctx.chat.push({ name: 'NPC', mes: '未来' });
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 9 } } });
        await f.runtime.prepareGeneration();
        // A new assistant floor is archived by the message save path.
        assert.ok((await reference(f, f.ctx.chat[2])));
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
        const id = (await reference(f, f.ctx.chat[0])).stateId;
        f.nodes.delete(id);
        f.ctx.chatMetadata = clone(f.ctx.chatMetadata);
        f.ctx.chatId = 'branch';
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), false);
        await assert.rejects(f.runtime.prepareGeneration(), /恢复失败|未恢复|找不到/);
        assert.ok(f.reports.some(message => /找不到/.test(message)));
    } finally { f.runtime.destroy(); }
});

for (const missing of ['state', 'index']) {
    test(`story backup import repairs a missing ${missing} file while restoration remains explicit`, async () => {
        const f = fixture();
        try {
            await f.runtime.migrate();
            f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 7 } } });
            await saveChatMetadata(f.ctx);
            const originalVariables = clone((await f.runtime.readStoryFloor(0)).variables);
            const bundle = await f.runtime.exportStory();
            const originalChat = clone(f.ctx.chat);
            const missingId = missing === 'index' ? bundle.marker.indexId
                : (await reference(f, f.ctx.chat[0])).stateId;
            assert.ok(bundle.graph.nodes[missingId]);
            assert.equal(f.nodes.delete(missingId), true);

            // Reopening must fail on the backing store, without trusting live variables.
            f.ctx.chatMetadata = clone(f.ctx.chatMetadata);
            f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 99 } } });
            const unrestoredVariables = clone(f.ctx.chatMetadata.variables);
            await f.runtime.restoreChat();
            assert.equal(f.runtime.ready(), false);
            assert.match(f.runtime.status().restoreError, /找不到/);
            await assert.rejects(f.runtime.prepareGeneration(), /恢复失败|未恢复|找不到/);
            assert.deepEqual(f.ctx.chatMetadata.variables, unrestoredVariables);

            const beforeImport = clone(f.ctx.chatMetadata);
            const result = await f.runtime.importStory(bundle);
            assert.equal(result.imported, true);
            assert.deepEqual(f.nodes.get(missingId), bundle.graph.nodes[missingId]);
            assert.deepEqual(f.ctx.chatMetadata, beforeImport,
                'file import must not overwrite current variables, marker, or native logs');
            assert.deepEqual(f.ctx.chat, originalChat,
                'file import must preserve message identities, candidate identities, and prose');
            assert.equal(f.runtime.ready(), false, 'import must not mark an unrestored branch ready');
            assert.match(f.runtime.status().restoreError, /找不到/);

            await f.runtime.restoreChat();
            assert.equal(f.runtime.ready(), true);
            assert.equal(f.runtime.status().restoreError, '');
            assert.deepEqual(f.ctx.chatMetadata.variables, originalVariables);
            assert.deepEqual(f.ctx.chat, originalChat);
        } finally { f.runtime.destroy(); }
    });
}

async function brokenIdentityFixture() {
    const f = fixture();
    try {
        await f.runtime.migrate();
        const message = { name: 'NPC', mes: '第一候选', swipes: ['第一候选', '第二候选'], swipe_id: 0,
            swipe_info: [{ extra: {} }, { extra: {} }] };
        f.ctx.chat.push(message);
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 2 } } });
        await saveChatMetadata(f.ctx);
        const first = await reference(f, message);
        message.swipe_id = 1;
        message.mes = message.swipes[1];
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 3 } } });
        await saveChatMetadata(f.ctx);
        const second = await reference(f, message);
        assert.notEqual(first.stateId, second.stateId);
        const originalChat = clone(f.ctx.chat);
        const source = [JSON.stringify({ chat_metadata: clone(f.ctx.chatMetadata) }),
            ...originalChat.map(row => JSON.stringify(row))].join('\n');
        const bundle = await f.runtime.exportStory();
        message.swipe_info[1].extra[STORY_CANDIDATE_ID] = candidateId(message, 0);
        message.extra[STORY_CANDIDATE_ID] = candidateId(message, 0);
        f.ctx.chatMetadata = clone(f.ctx.chatMetadata);
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 99 } } });
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), false);
        assert.match(f.runtime.status().restoreError, /重复 Swipe/);
        return { f, message, source, bundle, originalChat, first, second };
    } catch (error) { f.runtime.destroy(); throw error; }
}

test('runtime repairs candidate identities while unready and restores the original states only on explicit retry', async () => {
    const { f, message, source, bundle, originalChat, first, second } = await brokenIdentityFixture();
    try {
        await assert.rejects(f.runtime.prepareGeneration(), /恢复失败|未恢复|重复 Swipe/);
        const brokenChat = clone(f.ctx.chat), metadata = clone(f.ctx.chatMetadata), nodes = clone([...f.nodes]);
        await f.runtime.importStory(bundle);
        assert.deepEqual(f.ctx.chat, brokenChat, 'file import alone must not change identities');
        assert.equal(f.runtime.ready(), false);
        const preview = await f.runtime.inspectStoryIdentityRecovery(source);
        assert.deepEqual(f.ctx.chat, brokenChat);
        assert.deepEqual(f.ctx.chatMetadata, metadata);
        const saves = f.fullSaves;
        const result = await f.runtime.repairStoryIdentities(preview.plan);
        assert.equal(result.changed, true);
        assert.equal(f.fullSaves, saves + 1, 'message identities need one full host chat save');
        assert.deepEqual(f.ctx.chat, originalChat);
        assert.deepEqual(f.ctx.chatMetadata, metadata, 'identity save must skip capture and retain live variables and native logs');
        assert.deepEqual([...f.nodes], nodes, 'identity save must not create states or replacement index files');
        assert.equal(f.runtime.ready(), false);
        assert.match(f.runtime.status().restoreError, /重试恢复/);

        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), true);
        assert.equal((await reference(f, message)).stateId, second.stateId);
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间, 3);
        message.swipe_id = 0;
        message.mes = message.swipes[0];
        message.extra[STORY_CANDIDATE_ID] = candidateId(message, 0);
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), true);
        assert.equal((await reference(f, message)).stateId, first.stateId);
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间, 2);
    } finally { f.runtime.destroy(); }
});

test('runtime identity repair rolls back on host save failure without capturing current variables', async () => {
    const { f, source, originalChat } = await brokenIdentityFixture();
    try {
        const brokenChat = clone(f.ctx.chat), metadata = clone(f.ctx.chatMetadata), nodes = clone([...f.nodes]);
        const preview = await f.runtime.inspectStoryIdentityRecovery(source);
        const save = f.ctx.saveChat;
        let attempts = 0;
        f.ctx.saveChat = async () => { attempts++; throw Error('identity save unavailable'); };
        await assert.rejects(f.runtime.repairStoryIdentities(preview.plan), /identity save unavailable/);
        assert.equal(attempts, 1);
        assert.deepEqual(f.ctx.chat, brokenChat);
        assert.deepEqual(f.ctx.chatMetadata, metadata);
        assert.deepEqual([...f.nodes], nodes);
        assert.equal(f.runtime.ready(), false);
        await assert.rejects(f.runtime.prepareGeneration(), /恢复失败|未恢复|重复 Swipe/);
        f.ctx.saveChat = save;
        const retry = await f.runtime.inspectStoryIdentityRecovery(source);
        await f.runtime.repairStoryIdentities(retry.plan);
        assert.deepEqual(f.ctx.chat, originalChat, 'failed save must release the write lock for a new explicit preview');
        assert.deepEqual(f.ctx.chatMetadata, metadata);
        assert.deepEqual([...f.nodes], nodes);
        assert.equal(f.runtime.ready(), false);
    } finally { f.runtime.destroy(); }
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function identityRecoveryDestination(ctx, originalChat) {
    return { ...ctx, chatId: 'identity-recovery-destination', chat: clone(originalChat),
        chatMetadata: clone(ctx.chatMetadata), async saveChat() {}, async saveMetadata() {} };
}

for (const destinationState of ['ready', 'restoring']) {
    test(`a delayed identity save from the previous chat leaves the destination ${destinationState} state intact`, async () => {
        const { f, source, originalChat } = await brokenIdentityFixture();
        const hostSaveStarted = deferred(), finishHostSave = deferred(), destinationRestoreStarted = deferred(), finishDestinationRestore = deferred();
        let destinationTask;
        try {
            const sourceContext = f.ctx;
            const destination = identityRecoveryDestination(sourceContext, originalChat);
            sourceContext.saveChat = async () => { hostSaveStarted.resolve(); await finishHostSave.promise; };
            const preview = await f.runtime.inspectStoryIdentityRecovery(source);
            const repairing = f.runtime.repairStoryIdentities(preview.plan)
                .then(value => ({ value }), error => ({ error }));
            await hostSaveStarted.promise;

            if (destinationState === 'restoring') {
                const restore = f.story.restoreFloor;
                f.story.restoreFloor = async (...args) => {
                    destinationRestoreStarted.resolve();
                    await finishDestinationRestore.promise;
                    return restore(...args);
                };
            }
            f.ctx = destination;
            destinationTask = f.runtime.restoreChat();
            if (destinationState === 'ready') {
                await destinationTask;
                assert.equal(f.runtime.ready(), true);
            } else {
                await destinationRestoreStarted.promise;
                assert.equal(f.runtime.status().restoring, true);
            }
            const destinationChat = clone(destination.chat), destinationMetadata = clone(destination.chatMetadata);
            finishHostSave.resolve();
            await repairing;
            assert.deepEqual(destination.chat, destinationChat);
            assert.deepEqual(destination.chatMetadata, destinationMetadata);
            assert.equal(f.runtime.status().restoreError, '', 'the previous chat must not mark the destination failed');
            assert.equal(f.runtime.status().restoring, destinationState === 'restoring',
                'the previous chat must not clear a later restore task');
            assert.equal(f.runtime.ready(), destinationState === 'ready');
            finishDestinationRestore.resolve();
            await destinationTask;
            assert.equal(f.runtime.ready(), true);
            assert.equal(JSON.parse(destination.chatMetadata.variables.状态栏).项目.世界.时间, 3);
        } finally {
            finishHostSave.resolve(); finishDestinationRestore.resolve();
            if (destinationTask) await destinationTask;
            f.runtime.destroy();
        }
    });
}

test('identity save rejects a changed candidate after asynchronous preparation before dispatching to the host', async () => {
    const { f, message, source } = await brokenIdentityFixture();
    const preparationStarted = deferred(), finishPreparation = deferred();
    let removePreparation = () => {};
    try {
        const preview = await f.runtime.inspectStoryIdentityRecovery(source);
        const metadata = clone(f.ctx.chatMetadata), nodes = clone([...f.nodes]);
        let hostSaves = 0;
        f.ctx.saveChat = async () => { hostSaves++; };
        removePreparation = registerChatSavePreparation(async () => {
            preparationStarted.resolve(); await finishPreparation.promise;
        });
        const repairing = f.runtime.repairStoryIdentities(preview.plan)
            .then(value => ({ value }), error => ({ error }));
        await preparationStarted.promise;
        message.swipes[0] += ' changed during save preparation';
        const changedBody = message.swipes[0];
        finishPreparation.resolve();
        const result = await repairing;
        assert.ok(result.error, 'the final identity context check must reject changed candidate evidence');
        assert.equal(hostSaves, 0, 'stale identity evidence must not reach the host save');
        assert.equal(message.swipes[0], changedBody, 'rollback must not overwrite a concurrent body edit');
        assert.deepEqual(f.ctx.chatMetadata, metadata);
        assert.deepEqual([...f.nodes], nodes);
        assert.equal(f.runtime.ready(), false);
    } finally { finishPreparation.resolve(); removePreparation(); f.runtime.destroy(); }
});

test('identity save preserves the host error when a chat switch prevents rollback', async () => {
    const { f, source, originalChat } = await brokenIdentityFixture();
    const hostSaveStarted = deferred(), finishHostSave = deferred();
    try {
        const sourceContext = f.ctx, destination = identityRecoveryDestination(sourceContext, originalChat);
        const hostError = Error('original host identity save failure');
        sourceContext.saveChat = async () => { hostSaveStarted.resolve(); await finishHostSave.promise; };
        const preview = await f.runtime.inspectStoryIdentityRecovery(source);
        const repairing = f.runtime.repairStoryIdentities(preview.plan)
            .then(value => ({ value }), error => ({ error }));
        await hostSaveStarted.promise;
        f.ctx = destination;
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), true);
        const destinationChat = clone(destination.chat), destinationMetadata = clone(destination.chatMetadata);
        finishHostSave.reject(hostError);
        const result = await repairing;
        assert.strictEqual(result.error, hostError, 'a failed context check in rollback must not replace the actual save error');
        assert.deepEqual(destination.chat, destinationChat);
        assert.deepEqual(destination.chatMetadata, destinationMetadata);
        assert.equal(f.runtime.ready(), true);
        assert.equal(f.runtime.status().restoreError, '');
    } finally { finishHostSave.resolve(); f.runtime.destroy(); }
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
        const previous = (await reference(f, f.ctx.chat[2]));
        await f.runtime.prepareGeneration('swipe');
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间, 1);
        assert.deepEqual((await reference(f, f.ctx.chat[2])), previous);
        assert.equal(f.runtime.ready(), true);
        const before = f.fullSaves;
        await f.runtime.reconcile();
        assert.deepEqual((await reference(f, f.ctx.chat[2])), previous);
        assert.equal(f.fullSaves, before);
    } finally { f.runtime.destroy(); }
});

test('late native update is archived once and unchanged reconciliations do not save', async () => {
    const f = fixture();
    try {
        await f.runtime.migrate();
        await f.runtime.reconcile();
        const initialRef = (await reference(f, f.ctx.chat[0])).stateId;
        const savesBefore = f.fullSaves;
        f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 项目: { 世界: { 时间: 4 } } });
        await f.runtime.reconcile();
        const updatedRef = (await reference(f, f.ctx.chat[0])).stateId;
        assert.notEqual(updatedRef, initialRef);
        assert.equal(f.fullSaves, savesBefore + 1);
        await f.runtime.reconcile();
        await f.runtime.reconcile();
        assert.equal((await reference(f, f.ctx.chat[0])).stateId, updatedRef);
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
  const old=clone(tail.swipe_info[0]),count=f.nodes.size,oldRef=await reference(f,tail);
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
  assert.notEqual((await reference(f, tail)).stateId,oldRef.stateId);
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


test('streaming never creates a partial reference and finished reply is archived once',async()=>{
 const f=fixture();try{
  await f.runtime.migrate();f.ctx.chat.push({name:'User',mes:'继续',is_user:true});await f.runtime.prepareGeneration();
  const m={name:'NPC',mes:'临时正文',gen_finished:'streaming-also-sets-this'};f.ctx.chat.push(m);
  f.ctx.streamingProcessor={isFinished:false};const count=f.nodes.size;
  f.ctx.chatMetadata.variables.状态栏=JSON.stringify({项目:{世界:{时间:7}}});
  await f.runtime.reconcile();await saveChatMetadata(f.ctx);
  assert.equal((await reference(f, m)),null);assert.equal(f.nodes.size,count);
  m.mes='完成正文';f.ctx.streamingProcessor.isFinished=true;await f.runtime.reconcile();
  assert.ok((await reference(f, m)));const saves=f.fullSaves;await f.runtime.reconcile();assert.equal(f.fullSaves,saves);
 }finally{f.runtime.destroy();}
});


test('nonstreaming generation also defers external capture until its end event',async()=>{
 const f=fixture();try{
  await f.runtime.migrate();f.ctx.chat.push({name:'User',mes:'继续',is_user:true});await f.handlers.get('generating')('normal',{},false);
  const m={name:'NPC',mes:'待处理正文'};f.ctx.chat.push(m);await saveChatMetadata(f.ctx);assert.equal((await reference(f, m)),null);
  await f.runtime.reconcile();assert.equal((await reference(f, m)),null);
  m.mes='最终正文';f.handlers.get('ended')();await f.runtime.reconcile();assert.ok((await reference(f, m)));
 }finally{f.runtime.destroy();}
});

test('late Swipe synchronization retries indexing even when the final body and variables are unchanged', async () => {
 const f=fixture();try{
  await f.runtime.migrate();f.ctx.chat.push({name:'User',mes:'继续',is_user:true});await f.runtime.prepareGeneration();
  const m={mes:'最终正文',swipes:['尚未同步'],swipe_id:0,swipe_info:[{extra:{}}]};f.ctx.chat.push(m);
  await f.runtime.reconcile();assert.equal(await reference(f,m),null);
  m.swipes[0]=m.mes;await f.runtime.reconcile();assert.ok(await reference(f,m));
 }finally{f.runtime.destroy();}
});

test('runtime diagnostics compare native variable changes after generation and clear across chats', async () => {
 const f=fixture();try{
  await f.runtime.migrate();f.ctx.chat.push({name:'User',mes:'继续',is_user:true});await f.handlers.get('generating')('normal',{},false);
  f.ctx.chat.push({name:'NPC',mes:'回复<state>状态栏.项目.世界.时间: 7</state>'});
  f.ctx.chatMetadata.variables.状态栏=JSON.stringify({项目:{世界:{时间:7}}});f.handlers.get('ended')();
  await new Promise(r=>setTimeout(r,100));
  const rows=f.runtime.updateDiagnostics();assert.equal(rows.length,1);assert.equal(rows[0].receivedState,true);
  assert.ok(rows[0].changes.some(row=>row.path==='状态栏.项目.世界.时间'&&row.before==='1'&&row.after==='7'));
  assert.equal(f.nativeCalls,0);
  f.ctx.chatId='different';assert.deepEqual(f.runtime.updateDiagnostics(),[]);
  await f.handlers.get('chat')();assert.deepEqual(f.runtime.updateDiagnostics(),[]);
 }finally{f.runtime.destroy();}
});


test('continuation and body edits retain stable identity while state changes update only the index',async()=>{
 const f=fixture();try{
  await f.runtime.migrate();const m=f.ctx.chat[0],before=await reference(f,m),id=m[STORY_MESSAGE_ID];
  await f.handlers.get('generating')('continue',{},false);m.mes+=' 续写中的内容';await saveChatMetadata(f.ctx);
  assert.deepEqual(await reference(f,m),before);
  f.ctx.chatMetadata.variables.状态栏=JSON.stringify({项目:{世界:{时间:7}}});
  m.mes+=' 完成';f.handlers.get('ended')();await f.runtime.reconcile();
  assert.notEqual((await reference(f,m)).stateId,before.stateId);
  m.mes+=' 用户编辑正文';await saveChatMetadata(f.ctx);
  assert.equal(m[STORY_MESSAGE_ID],id);
  await f.runtime.restoreChat();assert.equal(f.runtime.ready(),true);
  assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.时间,7);
 }finally{f.runtime.destroy();}
});
