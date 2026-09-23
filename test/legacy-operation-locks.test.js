import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationService, metadataWriteStatus, subscribeStateChanges } from '../apps/shared/operations.js';
import { createSceneService, PROMPT_KEY as SCENE_PROMPT } from '../apps/scene/service.js';
import { KEY as SCENE_KEY, readCurrentScene } from '../apps/scene/model.js';
import { createJournal, PROMPT_KEY as JOURNAL_PROMPT } from '../apps/journal/service.js';
import { KEY as JOURNAL_KEY, empty, change, sourceFromRange } from '../apps/journal/model.js';

const clock = { year: 1926, month: 1, day: 2, hour: 8, minute: 0, calendarLabel: '' };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
function fixture({ ai } = {}) {
    const handlers = new Map(), prompts = new Map(); let saveImpl = async () => {}, saveCount = 0;
    const eventNames = ['GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'CHAT_CHANGED', 'MESSAGE_UPDATED'];
    let ctx = { chatId: 'a', characterId: 1, chatMetadata: {}, chat: [{ name: '玩家', is_user: true, mes: '进入港口' }, { name: '主持人', is_user: false, mes: '港口遗留了带徽记的信。', swipe_id: 0 }],
        getCurrentChatId() { return this.chatId; }, saveMetadata: async () => { saveCount++; await saveImpl(); }, setExtensionPrompt: (key, value) => prompts.set(key, value),
        eventTypes: Object.fromEntries(eventNames.map(name => [name, name])), eventSource: { on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); }, removeListener(name, fn) { handlers.get(name)?.delete(fn); } } };
    const getContext = () => ctx, scene = createSceneService(getContext), journal = createJournal(getContext, { ai: () => ai }), operations = createOperationService(getContext);
    const emit = (name, ...args) => { for (const fn of [...(handlers.get(name) ?? [])]) fn(...args); };
    return { getContext, scene, journal, operations, prompts, emit, get ctx() { return ctx; }, saves: () => saveCount,
        setSave(fn) { saveImpl = fn; }, switchChat(id = 'b') { const old = ctx; ctx = { ...ctx, chatId: id, chatMetadata: {}, chat: [...ctx.chat] }; emit('CHAT_CHANGED'); return old; },
        close() { scene.dispose(); journal.dispose(); operations.dispose(); } };
}
const hook = ctx => ({ id: 'letter', kind: 'hook', title: '徽记来信', body: '确认信件来自哪里。', status: 'open', actors: ['玩家'], enabled: true, sources: sourceFromRange(ctx.chat, 0, 1) });
const saveHook = (f, token = f.journal.capture()) => f.journal.save(token, (store, ctx) => change(store, ctx.chat, 'create', hook(ctx), token.operationId));
const patch = (operations, path, value) => operations.stage({ label: '外部更新', patches: [{ path: [path], value }], summary: '测试跨应用保存' });

test('scene save leases metadata across persistence and blocks both restore and a journal writer', async () => {
    const f = fixture(), gate = deferred(); patch(f.operations, JOURNAL_KEY, empty());
    f.scene.stage('set-time', { clock, reason: '剧情起点' }); f.setSave(() => gate.promise);
    const saving = f.scene.confirm(); assert.equal(metadataWriteStatus(f.getContext).busy, true);
    await assert.rejects(f.operations.confirm(), /正在保存/); await assert.rejects(saveHook(f), /正在保存/);
    assert.equal(f.ctx.chatMetadata[JOURNAL_KEY], undefined); assert.equal(f.saves(), 1);
    gate.resolve(); await saving; f.setSave(async () => {}); await f.operations.confirm();
    assert.deepEqual(readCurrentScene(f.ctx).clock, clock); assert.equal(metadataWriteStatus(f.getContext).busy, false); f.close();
});

test('native scene commits publish current time under the lease before persistence completes', async () => {
    const f = fixture(), gate = deferred(), observed = [];
    const unsubscribe = subscribeStateChanges((event, metadata) => {
        if (metadata === f.ctx.chatMetadata && event.phase === 'applied' && event.paths.some(path => path[0] === SCENE_KEY)) observed.push({ clock: readCurrentScene(f.ctx).clock, locked: metadataWriteStatus(f.getContext).busy });
    });
    f.scene.stage('set-time', { clock, reason: '起点' }); f.setSave(() => gate.promise); const saving = f.scene.confirm();
    assert.deepEqual(observed, [{ clock, locked: true }]); assert.equal(f.scene.preview(), null); assert.equal(f.scene.busy(), true);
    gate.resolve(); await saving; assert.equal(f.scene.dirty(), false); unsubscribe(); f.close();
});

test('journal save blocks restore and scene writes before either mutates metadata', async () => {
    const f = fixture(), gate = deferred(); patch(f.operations, 'amin_os_characters_v1', { version: 1, events: [] });
    f.scene.stage('set-time', { clock, reason: '起点' }); f.setSave(() => gate.promise);
    const saving = saveHook(f); assert.equal(metadataWriteStatus(f.getContext).busy, true);
    await assert.rejects(f.operations.confirm(), /正在保存/); await assert.rejects(f.scene.confirm(), /正在保存/);
    assert.equal(f.ctx.chatMetadata[SCENE_KEY], undefined); assert.equal(f.ctx.chatMetadata.amin_os_characters_v1, undefined); assert.ok(f.scene.preview());
    gate.resolve(); await saving; f.setSave(async () => {}); await f.operations.confirm(); await f.scene.confirm();
    assert.equal(f.journal.read().events.length, 1); assert.equal(f.ctx.chatMetadata[SCENE_KEY].events.length, 1); f.close();
});

test('shared operations block both legacy writers while saving and until failed persistence is retried', async () => {
    const f = fixture(), gate = deferred(); f.scene.stage('set-time', { clock, reason: '起点' }); const journalToken = f.journal.capture();
    patch(f.operations, 'amin_os_characters_v1', { version: 1, events: [] }); f.setSave(() => gate.promise);
    const saving = f.operations.confirm(), rejected = assert.rejects(saving, /失败/);
    await assert.rejects(f.scene.confirm(), /正在保存/); await assert.rejects(saveHook(f, journalToken), /正在保存/);
    gate.reject(Error('断网')); await rejected;
    await assert.rejects(f.scene.confirm(), /尚未保存/); await assert.rejects(saveHook(f, journalToken), /尚未保存/);
    assert.equal(f.ctx.chatMetadata[SCENE_KEY], undefined); assert.equal(f.ctx.chatMetadata[JOURNAL_KEY], undefined);
    f.setSave(async () => {}); await f.operations.retrySave(); await f.scene.confirm(); await saveHook(f, journalToken);
    assert.equal(f.ctx.chatMetadata[SCENE_KEY].events.length, 1); assert.equal(f.journal.read().events.length, 1); f.close();
});

test('scene retry obtains the same lease and never applies the time transition twice', async () => {
    const f = fixture(); f.setSave(async () => { throw Error('断网'); }); f.scene.stage('set-time', { clock, reason: '起点' });
    await assert.rejects(f.scene.confirm(), /不会再次推进/); assert.equal(f.scene.dirty(), true); assert.equal(metadataWriteStatus(f.getContext).busy, false);
    const gate = deferred(); f.setSave(() => gate.promise); const retry = f.scene.retrySave();
    await assert.rejects(saveHook(f), /正在保存/); assert.throws(() => patch(f.operations, JOURNAL_KEY, empty()), /正在保存/);
    gate.resolve(); await retry; assert.equal(f.scene.dirty(), false); assert.equal(f.ctx.chatMetadata[SCENE_KEY].events.length, 1); f.close();
});

test('applied scene and journal patches clear prompts, cancel previews, and abort stale AI drafts immediately', async () => {
    const generated = deferred(); let aiSignal;
    const ai = { capture: () => ({}), generate(_task, _ctx, _request, options) { aiSignal = options.signal; return generated.promise; } };
    const f = fixture({ ai }); f.scene.stage('set-time', { clock, reason: '起点' }); await f.scene.confirm();
    f.scene.stage('settings', { enabled: true, includeInContext: true, reason: '读取' }); await f.scene.confirm(); await saveHook(f);
    f.emit('GENERATION_AFTER_COMMANDS', 'normal'); assert.ok(f.prompts.get(SCENE_PROMPT)); assert.ok(f.prompts.get(JOURNAL_PROMPT));
    const token = f.journal.capture(), sceneToken = f.scene.capture(); f.scene.stage('advance-time', { minutes: 30, reason: '尚未确认的休息' });
    const draft = f.journal.generateDraft(token, { start: 0, end: 1 }), rejected = assert.rejects(draft, /来源已变化|取消/);
    const events = []; f.journal.subscribe(event => events.push(event.type));
    const gate = deferred(); f.setSave(() => gate.promise);
    f.operations.stage({ label: '恢复当前状态', patches: [{ path: [SCENE_KEY], value: structuredClone(f.ctx.chatMetadata[SCENE_KEY]) }, { path: [JOURNAL_KEY], value: structuredClone(f.ctx.chatMetadata[JOURNAL_KEY]) }] });
    const restoring = f.operations.confirm();
    assert.equal(f.scene.preview(), null); assert.equal(f.prompts.get(SCENE_PROMPT), ''); assert.equal(f.prompts.get(JOURNAL_PROMPT), ''); assert.equal(aiSignal.aborted, true); assert.ok(events.includes('source'));
    assert.throws(() => f.scene.check(sceneToken), /聊天或消息候选/); assert.throws(() => f.journal.check(token), /来源已变化/);
    generated.resolve('旧草稿'); await rejected; gate.resolve(); await restoring; f.close();
});

test('unrelated paths and matching chat IDs with different metadata do not invalidate current editors', async () => {
    const f = fixture(); f.scene.stage('set-time', { clock, reason: '当前预览' }); const token = f.journal.capture();
    patch(f.operations, 'amin_os_characters_v1', { version: 1, events: [] }); await f.operations.confirm();
    assert.ok(f.scene.preview()); assert.doesNotThrow(() => f.journal.check(token));
    const oldCtx = { ...f.ctx, chatMetadata: {} }, oldOperations = createOperationService(() => oldCtx);
    oldOperations.stage({ label: '其他已加载副本', patches: [{ path: [SCENE_KEY], value: { version: 1, events: [] } }, { path: [JOURNAL_KEY], value: empty() }] });
    await oldOperations.confirm(); assert.ok(f.scene.preview()); assert.doesNotThrow(() => f.journal.check(token));
    assert.equal(f.ctx.chatMetadata[JOURNAL_KEY], undefined); oldOperations.dispose(); f.close();
});

test('journal persistence failure rolls back its own value and releases the metadata lease for retry', async () => {
    const f = fixture(), token = f.journal.capture(); f.setSave(async () => { throw Error('离线'); });
    await assert.rejects(saveHook(f, token), /离线/); assert.equal(f.ctx.chatMetadata[JOURNAL_KEY], undefined); assert.equal(metadataWriteStatus(f.getContext).busy, false);
    f.setSave(async () => {}); await saveHook(f, token); await saveHook(f, token);
    assert.equal(f.journal.read().events.length, 1); assert.equal(f.saves(), 2); f.close();
});

test('late journal success after chat switch retains saved original data and never reports current-chat success', async () => {
    const f = fixture(), gate = deferred(), token = f.journal.capture(); f.setSave(() => gate.promise);
    const saving = saveHook(f, token), rejected = assert.rejects(saving, /聊天已切换/), original = f.switchChat();
    gate.resolve(); await rejected; assert.equal(original.chatMetadata[JOURNAL_KEY].events.length, 1); assert.equal(f.ctx.chatMetadata[JOURNAL_KEY], undefined);
    assert.match(f.journal.status(), /原聊天/); assert.equal(metadataWriteStatus(() => original).busy, false); await assert.rejects(saveHook(f, token), /聊天已切换/); f.close();
});

test('journal cached success is invalid after an external restore, even when restored bytes are identical', async () => {
    const f = fixture(), token = f.journal.capture(); await saveHook(f, token); const saved = structuredClone(f.ctx.chatMetadata[JOURNAL_KEY]);
    patch(f.operations, JOURNAL_KEY, saved); await f.operations.confirm();
    await assert.rejects(saveHook(f, token), /来源已变化/); assert.equal(f.journal.read().events.length, 1); assert.equal(f.saves(), 2); f.close();
});

test('throwing update and throwing UI listeners cannot leak a legacy metadata lease', async () => {
    const f = fixture(); f.journal.subscribe(() => { throw Error('UI listener error'); }); f.scene.subscribe(() => { throw Error('UI listener error'); });
    await assert.rejects(f.journal.save(f.journal.capture(), () => { throw Error('invalid edit'); }), /invalid edit/);
    assert.equal(metadataWriteStatus(f.getContext).busy, false); f.scene.stage('set-time', { clock, reason: '起点' }); await f.scene.confirm();
    assert.equal(metadataWriteStatus(f.getContext).busy, false); assert.deepEqual(f.scene.read().clock, clock); f.close();
});
