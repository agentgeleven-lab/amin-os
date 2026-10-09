import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createCurrentStoryStorage, CURRENT_STORY_KEY } from '../apps/state2/current-story-storage.js';
import { applyCurrentStoryState } from '../apps/state2/current-native-bridge.js';
import { ROOTS } from '../apps/state2/storage.js';
import { createOperationService, captureContext, assertContext, acquireMetadataWrite } from '../apps/shared/operations.js';
import { checkpointState } from '../apps/status/state-checkpoint.js';
import { saveChatMetadata, registerChatSavePreparation } from '../apps/shared/chat-save.js';

const copy = value => structuredClone(value);
const state = counter => JSON.stringify({ 项目: { 世界: { counter } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ legacy = false } = {}) {
  const records = new Map(), handlers = new Map(), nativeHandlers = new Map();
  const calls = { metadata: 0, chat: 0, oldReplay: 0, oldIndex: 0, overlays: 0 };
  let failSave = false, saveHandler = null, ctx = {
    chatId: 'current-a', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'npc.png' }],
    chat: [{ name: 'NPC', mes: '开场', is_user: false, extra: {} }],
    eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_SWIPED: 'swiped', MESSAGE_DELETED: 'deleted', MESSAGE_UPDATED: 'updated', GENERATION_AFTER_COMMANDS: 'generating', GENERATION_ENDED: 'ended' },
    eventSource: { on(name, handler) { handlers.set(name, handler); }, removeListener(name) { handlers.delete(name); } },
    extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    chatMetadata: { integrity: 'current-fixture', variables: { 状态栏: '{ "项目": { "世界": { "counter": 1 } } }', Foreign: 'keep' },
      LWB_RULES_V2: { Foreign: { type: 'string' } }, globalAbility: { keep: true }, world_info: 'keep-worldbook' },
    async saveMetadata() { calls.metadata++; if (saveHandler) await saveHandler(); if (failSave) throw Error('host offline'); },
    async saveChat() { calls.chat++; if (failSave) throw Error('host offline'); }, saveMetadataDebounced() {},
  };
  const files = {
    available: () => true,
    async get(key) { return copy(records.get(key) ?? null); },
    async put(key, record, { expected } = {}) {
      assert.deepEqual(records.get(key) ?? null, expected, 'file overwrite must check the previous record');
      records.set(key, copy(record));
    },
  };
  const host = { LWB_StateV2: { applyText() { throw Error('must not execute state twice'); }, loadRulesFromMeta() {} },
    jQuery: () => ({ on(name, handler) { nativeHandlers.set(name, handler); }, off(name) { nativeHandlers.delete(name); } }) };
  const overlay = async (snapshot, options) => { calls.overlays++; return applyCurrentStoryState(snapshot, options); };
  const current = createCurrentStoryStorage(() => ctx, { files, host, restoreState: (_floor, snapshot, options) => overlay(snapshot, options) });
  const legacyStory = {
    status: () => ({ available: false, enabled: true, indexed: true }),
    async ensureIndex() { calls.oldIndex++; throw Error('duplicate Swipe'); },
    async restoreFloor() { calls.oldReplay++; throw Error('old state unavailable'); },
    async restoreBeforeCandidate() { calls.oldReplay++; throw Error('must not rewind'); },
  };
  const runtime = createState2Runtime(() => ctx, { host, document: {}, interval: 0, currentStoryStorage: current,
    applyCurrentState: overlay, ...(legacy ? { storyStorage: legacyStory } : {}),
    restoreNative: async () => { calls.oldReplay++; throw Error('must not replay old floors'); } });
  return { records, calls, handlers, nativeHandlers, current, runtime, get ctx() { return ctx; }, set ctx(value) { ctx = value; },
    set failSave(value) { failSave = value; }, set saveHandler(value) { saveHandler = value; } };
}
const counter = f => JSON.parse(f.ctx.chatMetadata.variables.状态栏).项目.世界.counter;
const record = f => copy(f.records.get(f.ctx.chatMetadata[CURRENT_STORY_KEY].key));

test('new chat migration defaults to one current record without adding Swipe identities', async () => {
  const f = fixture(), chat = copy(f.ctx.chat);
  try {
    await f.runtime.migrate();
    assert.equal(f.runtime.ready(), true);
    assert.equal(f.runtime.status().currentOnly, true);
    assert.equal(f.runtime.storyStatus().indexed, false);
    assert.equal(f.records.size, 1);
    assert.deepEqual(f.ctx.chat, chat);
    assert.equal(f.calls.chat, 0);
    assert.equal(f.calls.oldReplay, 0);
    assert.equal(counter(f), 1);
    assert.equal(f.ctx.chatMetadata.variables.Foreign, 'keep');
  } finally { f.runtime.destroy(); }
});

test('switching out of failed legacy history uses live variables and preserves the old marker', async () => {
  const f = fixture({ legacy: true });
  try {
    await f.runtime.migrate();
    f.ctx.chatMetadata.amin_os_story_storage_v2 = { version: 2, invalidIndex: 'original untouched' };
    const old = copy(f.ctx.chatMetadata.amin_os_story_storage_v2);
    await f.runtime.restoreChat();
    assert.equal(f.runtime.ready(), false);
    assert.match(f.runtime.status().restoreError, /duplicate Swipe/);
    const reads = f.calls.oldIndex;
    await f.runtime.switchToCurrentStory();
    assert.equal(f.runtime.ready(), true);
    assert.equal(f.runtime.status().restoreError, '');
    assert.deepEqual(f.ctx.chatMetadata.amin_os_story_storage_v2, old);
    await f.runtime.restoreChat();
    assert.equal(f.calls.oldIndex, reads);
    assert.equal(counter(f), 1);
  } finally { f.runtime.destroy(); }
});

test('explicit clear preserves a recoverable snapshot and unrelated state without changing chat text', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    const chat = copy(f.ctx.chat), old = record(f).current.hash;
    await f.runtime.resetCurrentStory();
    assert.equal(f.runtime.ready(), true);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata.variables, '状态栏'), false);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata.variables, ROOTS.characters), false);
    assert.equal(f.ctx.chatMetadata.variables.Foreign, 'keep');
    assert.deepEqual(f.ctx.chatMetadata.globalAbility, { keep: true });
    assert.equal(f.ctx.chatMetadata.world_info, 'keep-worldbook');
    assert.deepEqual(f.ctx.chat, chat);
    const backups = await f.runtime.inspectCurrentStoryBackups();
    assert.equal(backups.backups[0].hash, old);
    await f.runtime.restoreCurrentStoryBackup(0, { expectedHash: old });
    assert.equal(counter(f), 1);
    assert.equal(f.runtime.ready(), true);
    assert.equal(f.calls.oldReplay, 0);
  } finally { f.runtime.destroy(); }
});

test('regenerate and swipe prepare from current state and retain only five backups in one file', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    f.ctx.chat.push({ mes: '候选 B', name: 'NPC', swipes: ['候选 A', '候选 B'], swipe_id: 1,
      swipe_info: [{ extra: { amin_story_candidate_id: 'copied' } }, { extra: { amin_story_candidate_id: 'copied' } }], extra: {} });
    await f.runtime.prepareGeneration('regenerate');
    assert.equal(counter(f), 1);
    for (let n = 2; n <= 9; n++) {
      f.ctx.chatMetadata.variables.状态栏 = state(n);
      const log = f.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2;
      log.floors[String(n)] = { signature: 'new', roots: ['状态栏'], rules: [], ops: [{ path: '状态栏.counter', op: 'set', value: n }] };
      await saveChatMetadata(f.ctx);
      assert.equal(counter(f), n);
    }
    await f.runtime.prepareGeneration('swipe');
    assert.equal(counter(f), 9);
    assert.equal(f.records.size, 1);
    assert.equal(record(f).backups.length, 5);
    assert.equal(f.calls.chat, 0);
    assert.equal(f.calls.oldReplay, 0);
    assert.deepEqual(Object.keys(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors), ['-1']);
    await assert.rejects(f.runtime.readStoryFloor(0), /不提供旧楼层/);
  } finally { f.runtime.destroy(); }
});

test('host save failure rolls clear back in both the live native state and mutable file', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    const before = copy(f.ctx.chatMetadata), previous = record(f);
    f.failSave = true;
    await assert.rejects(f.runtime.resetCurrentStory(), /host offline/);
    assert.deepEqual(f.ctx.chatMetadata, before);
    assert.deepEqual(record(f), previous);
    assert.equal(f.runtime.ready(), true);
    assert.equal(counter(f), 1);
  } finally { f.runtime.destroy(); }
});

test('a candidate edit in later preparation prevents a current reset from reaching the host', async () => {
  const f = fixture(); let remove;
  try {
    await f.runtime.migrate();
    const saves = f.calls.metadata;
    remove = registerChatSavePreparation(async () => { f.ctx.chat[0].mes = 'changed while preparing'; });
    await assert.rejects(f.runtime.resetCurrentStory(), /聊天|候选/);
    assert.equal(f.calls.metadata, saves);
  } finally { remove?.(); f.runtime.destroy(); }
});

test('reopening a truncated branch loads current state without original floor or candidate validation', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    await f.runtime.prepareGeneration('normal');
    f.ctx.chatMetadata.variables.状态栏 = state(8);
    await saveChatMetadata(f.ctx);
    f.ctx = { ...f.ctx, chatId: 'current-branch', chatMetadata: copy(f.ctx.chatMetadata),
      chat: [{ mes: 'earlier body', swipes: ['earlier body'], swipe_id: 0, swipe_info: [{ extra: {} }] }] };
    f.ctx.chatMetadata.variables.状态栏 = state(0);
    await f.runtime.restoreChat();
    assert.equal(counter(f), 8);
    assert.equal(f.records.size, 2, 'fork uses its own mutable record');
    assert.equal(f.runtime.ready(), true);
    assert.equal(f.calls.oldReplay, 0);
  } finally { f.runtime.destroy(); }
});

test('late native historical updates after swipe never become the canonical current snapshot', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    await f.runtime.prepareGeneration('normal');
    f.ctx.chatMetadata.variables.状态栏 = state(8);
    await saveChatMetadata(f.ctx);
    f.ctx.chat[0].swipes = ['开场', '另一候选']; f.ctx.chat[0].swipe_id = 1; f.ctx.chat[0].mes = '另一候选';
    await f.handlers.get('swiped')(0);
    const latest = record(f);
    await new Promise(resolve => setTimeout(() => {
      f.ctx.chatMetadata.variables.状态栏 = state(0);
      f.nativeHandlers.get('xiaobaix:variables:stateAtomsGenerated.aminState2')({}, { messageId: 0, atoms: [{}] });
      resolve();
    }, 10));
    await tick(); await f.runtime.reconcile(); await tick();
    assert.equal(counter(f), 8);
    assert.deepEqual(record(f), latest);
    assert.equal(f.runtime.ready(), true);
  } finally { f.runtime.destroy(); }
});

test('a confirmed manual variable operation releases navigation protection before capturing its own new state', async () => {
  const f = fixture(), op = createOperationService(() => f.ctx);
  try {
    await f.runtime.migrate();
    await f.runtime.restoreChat();
    op.stage({ label: 'manual current state', patches: [{ path: ['variables', '状态栏'], value: state(7) }] });
    await op.confirm();
    assert.equal(counter(f), 7);
    assert.equal(JSON.parse((await f.runtime.readStoryFloor(0)).variables.状态栏).项目.世界.counter, 7);
    assert.equal(f.runtime.ready(), true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Object.keys(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points).length, 1);
    assert.deepEqual(Object.keys(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors), ['-1']);
  } finally { op.dispose(); f.runtime.destroy(); }
});

test('an owned rule-only manual operation is saved without navigation protection reverting it', async () => {
  const f = fixture(), op = createOperationService(() => f.ctx);
  try {
    await f.runtime.migrate(); await f.runtime.restoreChat();
    op.stage({ label: 'manual owned rule', patches: [{ path: ['LWB_RULES_V2', 'AminOS骰子.custom'], value: { type: 'object', note: 'new' } }] });
    await op.confirm();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2['AminOS骰子.custom'], { type: 'object', note: 'new' });
    const saved = await f.runtime.readStoryFloor(0);
    assert.deepEqual(saved.rules['AminOS骰子.custom'], { type: 'object', note: 'new' });
    assert.equal(f.runtime.ready(), true);
  } finally { op.dispose(); f.runtime.destroy(); }
});

test('reset immediately after a delayed historical write backs up the canonical latest state', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate(); await f.runtime.prepareGeneration('normal');
    f.ctx.chatMetadata.variables.状态栏 = state(8); await saveChatMetadata(f.ctx);
    await f.runtime.restoreChat();
    f.ctx.chatMetadata.variables.状态栏 = state(0);
    await f.runtime.resetCurrentStory();
    const backups = await f.runtime.inspectCurrentStoryBackups();
    await f.runtime.restoreCurrentStoryBackup(0, { expectedHash: backups.backups[0].hash });
    assert.equal(counter(f), 8);
  } finally { f.runtime.destroy(); }
});

test('a generated tail update after generation ended accepts the late native generated state', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate();
    await f.handlers.get('generating')('normal', {}, false);
    f.ctx.chat[0].mes += '<state>generated</state>';
    f.handlers.get('ended')();
    // Generation diagnostic cleanup is not a correctness deadline for native
    // state application. The same completed candidate still owns this update.
    await new Promise(resolve => setTimeout(resolve, 85));
    f.handlers.get('updated')(0);
    await new Promise(resolve => setTimeout(() => {
      f.ctx.chatMetadata.variables.状态栏 = state(9);
      f.nativeHandlers.get('xiaobaix:variables:stateAtomsGenerated.aminState2')({}, { messageId: 0, atoms: [{}] });
      resolve();
    }, 10));
    await tick(); await f.runtime.reconcile(); await tick();
    assert.equal(counter(f), 9);
    assert.equal(JSON.parse((await f.runtime.readStoryFloor(0)).variables.状态栏).项目.世界.counter, 9);
  } finally { f.runtime.destroy(); }
});

test('current backup import remains file-only and cannot interleave with a pending reset host save', async () => {
  const f = fixture(); let resume;
  try {
    await f.runtime.migrate();
    const bundle = await f.runtime.exportStory();
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { resume = resolve; });
    f.saveHandler = async () => { started(); await held; };
    const reset = f.runtime.resetCurrentStory();
    await waiting;
    await assert.rejects(f.runtime.importStory(bundle), /操作|恢复|稍后/);
    resume(); await reset; f.saveHandler = null;
    const saves = f.calls.metadata, overlays = f.calls.overlays;
    await f.runtime.importStory(bundle);
    assert.equal(Object.hasOwn(f.ctx.chatMetadata.variables, '状态栏'), false);
    assert.equal(f.calls.metadata, saves);
    assert.equal(f.calls.overlays, overlays);
    await f.runtime.restoreChat();
    assert.equal(counter(f), 1);
  } finally { resume?.(); f.runtime.destroy(); }
});

test('direct status editor writes are accepted through their explicit checkpoint signal before saving', async () => {
  const f = fixture(); let release = () => {};
  try {
    await f.runtime.migrate(); await f.runtime.restoreChat();
    const token = captureContext(() => f.ctx);
    const ctx = assertContext(() => f.ctx, token);
    release = acquireMetadataWrite(() => f.ctx, token);
    // persistStatusChange and the status generator use this direct write path,
    // rather than modern operation patches or the legacy manual adapter.
    ctx.chatMetadata.variables.状态栏 = state(6);
    assert.equal(checkpointState(ctx), false);
    await saveChatMetadata(ctx); assertContext(() => f.ctx, token);
    assert.equal(counter(f), 6);
    assert.equal(JSON.parse((await f.runtime.readStoryFloor(0)).variables.状态栏).项目.世界.counter, 6);
    assert.equal(Object.keys(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points).length, 1);
  } finally { release(); f.runtime.destroy(); }
});

test('checkpoint writes in a preview shadow never release live historical replay protection', async () => {
  const f = fixture();
  try {
    await f.runtime.migrate(); await f.runtime.restoreChat();
    const shadow = { ...f.ctx, chatMetadata: copy(f.ctx.chatMetadata) };
    shadow.chatMetadata.variables.状态栏 = state(6);
    checkpointState(shadow);
    f.ctx.chatMetadata.variables.状态栏 = state(0);
    const saves = f.calls.metadata;
    await assert.rejects(saveChatMetadata(f.ctx), /旧候选/);
    assert.equal(f.calls.metadata, saves);
    await f.runtime.reconcile(); await f.runtime.restoreChat();
    assert.equal(counter(f), 1);
    assert.equal(JSON.parse((await f.runtime.readStoryFloor(0)).variables.状态栏).项目.世界.counter, 1);
  } finally { f.runtime.destroy(); }
});
