import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStorage } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { STORY_CANDIDATE_ID } from '../apps/shared/story-chat-index.js';

function fixture() {
  const nodes = new Map(), reads = new Map();
  const graph = createStoryStateGraph({ get: async id => { reads.set(id, (reads.get(id) ?? 0) + 1); return structuredClone(nodes.get(id) ?? null); },
    put: async (id, value) => { nodes.set(id, structuredClone(value)); } });
  let ctx = { chatId: 'origin', characterId: 0, characters: [{ avatar: 'a.png' }],
    extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    chat: [{ mes: 'first', is_user: false }],
    chatMetadata: { integrity: 'ready', variables: { 状态栏: '{"hp":10}' }, LWB_RULES_V2: {} } };
  const service = createStoryStorage(() => ctx, { graph });
  return { service, nodes, graph, reads, get ctx() { return ctx; }, set ctx(value) { ctx = value; } };
}

test('reference inspection shares parent reads within a batch and reloads changed files next time', async () => {
  const f = fixture();
  f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ hp: 10, notes: '背景'.repeat(3000) });
  const { baseStateId } = await f.service.enable(); await f.service.ensureIndex();
  f.ctx.chat.push({ mes: 'next', is_user: false });
  f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ hp: 7, notes: '背景'.repeat(3000) });
  const { stateId } = await f.service.capture();
  assert.equal(f.nodes.get(stateId).kind, 'delta');
  f.reads.clear();
  assert.deepEqual((await f.service.inspectReferences()).repairs, []);
  assert.equal(f.reads.get(baseStateId), 1);
  assert.equal(f.reads.get(stateId), 1);
  f.nodes.get(baseStateId).state.variables.状态栏.hp = 999;
  await assert.rejects(f.service.inspectReferences(), { code: 'STORY_STATE_CORRUPT' });
});

test('inspection keeps compatibility with adapters exposing only single-state load', async () => {
  const f = fixture(); delete f.graph.visitMany;
  await f.service.enable(); await f.service.ensureIndex();
  assert.equal((await f.service.inspectIndex()).unreadableStates, 0);
  assert.deepEqual((await f.service.inspectReferences()).repairs, []);
});

test('index inspection includes unselected swipes and inherited branch without mutating chat or files', async () => {
  const f = fixture();
  // Saved JSON sorts UUID-like keys; display must follow Swipe numbers instead.
  f.ctx.chat[0].extra = { [STORY_CANDIDATE_ID]: 'z-first' };
  await f.service.enable(); await f.service.ensureIndex();
  const message = f.ctx.chat[0];
  message.swipes = ['first', 'alternative']; message.swipe_id = 0;
  message.swipe_info = [{ extra: structuredClone(message.extra) }, { extra: { [STORY_CANDIDATE_ID]: 'a-second' } }];
  await f.service.ensureIndex();
  message.swipe_id = 1; message.mes = 'alternative';
  f.ctx.chatMetadata.variables.状态栏 = '{"hp":5}';
  await f.service.capture();
  const original = await f.service.inspectIndex();
  assert.equal(original.rows.length, 2);
  assert.notEqual(original.rows[0].stateId, original.rows[1].stateId);
  assert.equal(original.rows[0].selected, false);
  assert.equal(original.rows[1].selected, true);
  f.ctx = { ...structuredClone(f.ctx), chatId: 'branch' };
  const before = JSON.stringify(f.ctx), files = JSON.stringify([...f.nodes]);
  const branch = await f.service.inspectIndex();
  assert.match(branch.inheritedFrom.chat, /origin/);
  assert.equal(branch.rows[1].stateId, original.rows[1].stateId);
  assert.equal(branch.unreadableStates, 0);
  assert.ok(branch.storage.indexBytes > 0);
  assert.ok(branch.storage.stateBytes > 0);
  assert.equal(branch.storage.totalBytes, branch.storage.indexBytes + branch.storage.stateBytes);
  assert.equal(branch.cleanupAvailable, false);
  assert.equal(JSON.stringify(f.ctx), before);
  assert.equal(JSON.stringify([...f.nodes]), files);
});

test('inspection reports missing inactive candidate files and retains readable rows', async () => {
  const f = fixture(); await f.service.enable(); await f.service.ensureIndex();
  f.ctx.chat.push({ mes: 'next', is_user: false });
  f.ctx.chatMetadata.variables.状态栏 = '{"hp":7}';
  await f.service.capture();
  const before = await f.service.inspectIndex();
  f.nodes.delete(before.rows[1].stateId);
  const result = await f.service.inspectIndex();
  assert.equal(result.rows[0].readable, true);
  assert.equal(result.rows[1].readable, false);
  assert.equal(result.unreadableStates, 1);
  assert.equal(result.storage, null);
  assert.ok(result.storageError);
  assert.ok(result.rows[1].error);
});

test('inspection refuses results after chat switch or index changes during file reads', async () => {
  for (const change of ['chat', 'index']) {
    const f = fixture(); await f.service.enable(); await f.service.ensureIndex();
    const original = f.graph.load;
    let release, arrived;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    let first = true;
    f.graph.load = async id => { if (first) { first = false; arrived(); await pause; } return original(id); };
    const inspection = f.service.inspectIndex(); await waiting;
    if (change === 'chat') f.ctx = { ...structuredClone(f.ctx), chatId: 'other' };
    else f.ctx.chatMetadata.amin_os_story_storage_v2.indexId = `sha256:${'a'.repeat(64)}`;
    release();
    await assert.rejects(inspection, error => error.code === 'STORY_CHAT_CHANGED');
  }
});
