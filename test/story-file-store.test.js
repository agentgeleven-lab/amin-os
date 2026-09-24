import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryFileStore, STORY_STORE_NAMESPACE, STORY_STORE_TABLE } from '../apps/shared/story-file-store.js';

const HASH_ID = `sha256:${'a'.repeat(64)}`;

function fixture() {
  const files = new Map();
  const writes = [];
  const extensionStore = {
    async tryGetJson(options) {
      const file = `${options.namespace}/${options.table}/${options.key}`;
      return files.has(file) ? { found: true, value: structuredClone(files.get(file)) } : { found: false };
    },
    async setJson(options) {
      const file = `${options.namespace}/${options.table}/${options.key}`;
      files.set(file, structuredClone(options.value));
      writes.push(file);
    },
  };
  const hostWindow = { __TAURITAVERN__: { api: { extension: { store: extensionStore } } } };
  return { files, writes, extensionStore, hostWindow, store: createStoryFileStore({ getHostWindow: () => hostWindow }) };
}

test('available is a synchronous API capability check without storage I/O', () => {
  const t = fixture();
  t.extensionStore.tryGetJson = () => { throw Error('unexpected read'); };
  t.extensionStore.setJson = () => { throw Error('unexpected write'); };
  assert.equal(t.store.available(), true);
  delete t.extensionStore.setJson;
  assert.equal(t.store.available(), false);
  assert.equal(createStoryFileStore({ getHostWindow: () => ({}) }).available(), false);
});

test('hash IDs map to valid TT filenames and JSON records remain immutable and idempotent', async () => {
  const { store, files, writes } = fixture();
  const input = { b: { two: 2 }, a: [1, null] };
  await store.put(HASH_ID, input);
  input.b.two = 9;
  const file = `${STORY_STORE_NAMESPACE}/${STORY_STORE_TABLE}/h-${'a'.repeat(64)}`;
  assert.deepEqual(files.get(file), { b: { two: 2 }, a: [1, null] });
  const loaded = await store.get(HASH_ID);
  loaded.b.two = 10;
  assert.equal((await store.get(HASH_ID)).b.two, 2);
  await store.put(HASH_ID, { a: [1, null], b: { two: 2 } });
  assert.deepEqual(writes, [file]);
  await assert.rejects(store.put(HASH_ID, { b: { two: 3 }, a: [1, null] }), error => error.code === 'STORY_ID_CONFLICT');
  assert.deepEqual(files.get(file), { b: { two: 2 }, a: [1, null] });
});

test('a literal safe ID cannot collide with a hash ID and missing data is explicit', async () => {
  const { store, writes } = fixture();
  await store.put(`h-${'a'.repeat(64)}`, { kind: 'literal' });
  await assert.rejects(store.get(HASH_ID), error => error.code === 'STORY_NOT_FOUND');
  assert.equal(writes[0], `${STORY_STORE_NAMESPACE}/${STORY_STORE_TABLE}/k-h-${'a'.repeat(64)}`);
});

test('unavailable host does not write to chat or browser storage', async () => {
  const context = { chatMetadata: {}, extensionSettings: {} };
  const hostWindow = { localStorage: { setItem() { throw Error('browser storage must not be used'); } } };
  const store = createStoryFileStore({ getHostWindow: () => hostWindow });
  await assert.rejects(store.put(HASH_ID, { state: 1 }), error => error.code === 'STORY_STORE_UNAVAILABLE');
  await assert.rejects(store.get(HASH_ID), error => error.code === 'STORY_STORE_UNAVAILABLE');
  assert.deepEqual(context, { chatMetadata: {}, extensionSettings: {} });
});

test('read, write and verification failures never report success', async () => {
  const t = fixture();
  t.extensionStore.tryGetJson = async () => { throw Error('disk read failed'); };
  await assert.rejects(t.store.get(HASH_ID), error => error.code === 'STORY_READ_FAILED' && /disk read failed/.test(error.cause.message));
  t.extensionStore.tryGetJson = async () => ({ found: false });
  t.extensionStore.setJson = async () => { throw Error('disk write failed'); };
  await assert.rejects(t.store.put(HASH_ID, { state: 1 }), error => error.code === 'STORY_WRITE_FAILED' && /disk write failed/.test(error.cause.message));
  t.extensionStore.setJson = async () => {};
  await assert.rejects(t.store.put(HASH_ID, { state: 1 }), error => error.code === 'STORY_WRITE_VERIFY_FAILED');
});

test('invalid JSON and malformed TT responses fail without creating a record', async () => {
  const t = fixture();
  await assert.rejects(t.store.put(HASH_ID, { value: undefined }), error => error.code === 'STORY_INVALID_JSON');
  await assert.rejects(t.store.put(HASH_ID, { value: Number.NaN }), error => error.code === 'STORY_INVALID_JSON');
  const arrayWithHiddenData = [1];
  arrayWithHiddenData.extra = 2;
  await assert.rejects(t.store.put(HASH_ID, arrayWithHiddenData), error => error.code === 'STORY_INVALID_JSON');
  await assert.rejects(t.store.put('bad/path', {}), error => error.code === 'STORY_INVALID_ID');
  assert.equal(t.writes.length, 0);
  t.extensionStore.tryGetJson = async () => null;
  await assert.rejects(t.store.get(HASH_ID), error => error.code === 'STORY_STORE_INVALID_RESPONSE');
});
