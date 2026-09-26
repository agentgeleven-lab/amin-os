import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryLibraryHost } from '../apps/shared/story-library-host.js';

const payload = [{ chat_metadata: { variables: { large: 'private variables' }, amin_os_story_storage_v2: { indexId: 'index' } } },
  { mes: 'selected', swipes: ['first', 'selected'], extra: { unrelated: 'secret', amin_story_v2: { stateId: 'selected' } },
    swipe_info: [{ extra: { amin_story_v2: { stateId: 'a' } } }, null, { extra: { amin_story_v2: { stateId: 'b' } } }] }];
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const routes = {
    '/api/characters/all': [{ avatar: 'a.png', name: 'A' }],
    '/api/characters/chats': [{ file_name: 'first.jsonl' }, { file_name: 'branch.jsonl' }],
    '/api/groups/all': [{ id: 'g', name: 'G', chats: ['group-chat'] }],
    '/api/backups/chat/get': [{ file_name: 'backup.jsonl' }],
    '/api/chats/get': payload, '/api/chats/group/get': payload,
    '/api/backups/chat/download': payload.map(row => JSON.stringify(row)).join('\n'),
    ...overrides,
  };
  return { calls, host: createStoryLibraryHost({ getHostWindow: () => ({ __TAURITAVERN__: {}, crypto: globalThis.crypto }),
    fetchImpl: async (path, init) => {
      calls.push({ path, body: JSON.parse(init.body) });
      const value = routes[path];
      if (value instanceof Error) throw value;
      return new Response(typeof value === 'string' ? value : JSON.stringify(value));
    }, ...options }) };
}
test('registered character branches, group chats and decoded backup retain every swipe', async () => {
  const { host, calls } = fixture();
  const result = await host.census();
  assert.equal(result.complete, true);
  assert.equal(result.entries.length, 4);
  assert.equal(result.entries.filter(row => row.kind === 'backup').length, 1);
  assert.deepEqual(result.entries[0].chat[0].swipe_info, payload[1].swipe_info);
  assert.deepEqual(result.entries[0].chat[0].extra, { amin_story_v2: { stateId: 'selected' } });
  assert.equal(result.entries[0].chat[0].mes, undefined);
  assert.equal(result.entries[0].chat[0].swipes, undefined);
  assert.equal(result.entries[0].chatMetadata.variables, undefined);
  assert.equal(result.projection, 'amin-story-references');
  assert.equal(result.entries[0].documentBytes, new TextEncoder().encode(JSON.stringify(payload)).byteLength);
  assert.equal(result.entries.find(row => row.kind === 'backup').documentBytes,
    new TextEncoder().encode(payload.map(row => JSON.stringify(row)).join('\n')).byteLength);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.capabilities.globalDiskCoverage, false);
  assert.equal(result.capabilities.maintenanceLock, false);
  assert.deepEqual(calls.find(row => row.path === '/api/backups/chat/get').body, { detail: 'catalog' });
  assert.equal(calls.some(row => /save|delete|set/.test(row.path)), false);
});
test('failed read, malformed catalog, malformed backup and cold swipe cannot be complete', async () => {
  for (const overrides of [
    { '/api/chats/get': new Error('unreadable') },
    { '/api/characters/chats': { entries: [] } },
    { '/api/backups/chat/download': '{broken' },
    { '/api/chats/get': [payload[0], { tt_swipe_cold: { sourceId: 1 } }] },
  ]) {
    const result = await fixture(overrides).host.census();
    assert.equal(result.complete, false);
    assert.ok(result.issues.length);
  }
});
test('byte and directory limits block completion and cancel stops further requests', async () => {
  for (const limits of [{ maxResponseBytes: 8 }, { maxTotalBytes: 100 }, { maxEntries: 1 }]) {
    assert.equal((await fixture({}, { limits }).host.census()).complete, false);
  }
  const controller = new AbortController();
  const { host, calls } = fixture();
  const result = await host.census({ signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(result.complete, false);
  assert.equal(calls.length, 1);
});
test('fingerprint changes when a hidden swipe reference changes', async () => {
  const a = await fixture().host.census();
  const changed = structuredClone(payload);
  changed[1].swipe_info[0].extra.amin_story_v2.stateId = 'new';
  const b = await fixture({ '/api/chats/get': changed }).host.census();
  assert.notEqual(a.fingerprint, b.fingerprint);
});
