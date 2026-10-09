import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryCurrentFileStore, STORY_CURRENT_STORE_NAMESPACE, STORY_CURRENT_STORE_TABLE } from '../apps/shared/story-current-file-store.js';

const KEY = 'current-1234abcd';
const location = key => `${STORY_CURRENT_STORE_NAMESPACE}/${STORY_CURRENT_STORE_TABLE}/${key}`;
const code = expected => error => error.code === expected;
function fixture() {
    const files = new Map(), writes = [], reads = [];
    const extensionStore = {
        async tryGetJson(options) {
            const file = `${options.namespace}/${options.table}/${options.key}`;
            reads.push(file);
            return files.has(file) ? { found: true, value: structuredClone(files.get(file)) } : { found: false };
        },
        async setJson(options) {
            const file = `${options.namespace}/${options.table}/${options.key}`;
            writes.push(file);
            files.set(file, structuredClone(options.value));
        },
    };
    const host = { __TAURITAVERN__: { api: { extension: { store: extensionStore } } } };
    return { files, writes, reads, extensionStore, host, store: createStoryCurrentFileStore({ getHostWindow: () => host }) };
}
const record = revision => ({ version: 1, current: { variables: { revision } }, backups: Array.from({ length: Math.min(revision, 5) }, (_, i) => ({ revision: revision - i - 1 })) });

test('mutable current records overwrite one isolated key and return detached clones', async () => {
    const f = fixture();
    f.files.set('amin-os/story-v2/h-old-hash', { original: true });
    assert.equal(await f.store.get(KEY), null);
    let expected = null;
    for (let revision = 0; revision < 8; revision++) {
        const value = record(revision);
        await f.store.put(KEY, value, { expected });
        expected = structuredClone(value);
        value.current.variables.revision = 100;
    }
    assert.deepEqual(await f.store.get(KEY), record(7));
    const loaded = await f.store.get(KEY);
    loaded.current.variables.revision = 200;
    assert.deepEqual(await f.store.get(KEY), record(7));
    assert.equal(f.writes.length, 8);
    assert.deepEqual(new Set(f.writes), new Set([location(KEY)]));
    assert.equal(f.files.size, 2);
    assert.deepEqual(f.files.get('amin-os/story-v2/h-old-hash'), { original: true });
});

test('compare-before-write uses canonical old-record equality and refuses stale or blind writes', async () => {
    const f = fixture();
    const old = { version: 1, current: { b: 2, a: 1 }, backups: [] };
    await f.store.put(KEY, old, { expected: null });
    const next = record(1);
    await f.store.put(KEY, next, { expected: { backups: [], current: { a: 1, b: 2 }, version: 1 } });
    await assert.rejects(f.store.put(KEY, record(2), { expected: old }), code('STORY_CURRENT_CONFLICT'));
    await assert.rejects(f.store.put(KEY, record(2), { expected: null }), code('STORY_CURRENT_CONFLICT'));
    await assert.rejects(f.store.put(KEY, record(2)), code('STORY_CURRENT_EXPECTED_REQUIRED'));
    await assert.rejects(f.store.put('current-missing', record(2), { expected: old }), code('STORY_CURRENT_CONFLICT'));
    assert.equal(f.writes.length, 2);
    assert.deepEqual(await f.store.get(KEY), next);
});

test('same-host adapters refuse overlapping writes to the same mutable key', async () => {
    const f = fixture(), other = createStoryCurrentFileStore({ getHostWindow: () => f.host });
    let resolveWrite, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const originalSet = f.extensionStore.setJson;
    f.extensionStore.setJson = async options => {
        entered();
        await new Promise(resolve => { resolveWrite = resolve; });
        await originalSet(options);
    };
    const first = f.store.put(KEY, record(0), { expected: null });
    await started;
    await assert.rejects(other.put(KEY, record(1), { expected: null }), code('STORY_CURRENT_CONFLICT'));
    resolveWrite();
    await first;
    assert.equal(f.writes.length, 1);
    assert.deepEqual(await f.store.get(KEY), record(0));
});

test('different keys remain independently writable while a record is pending', async () => {
    const f = fixture();
    let resolveFirst, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const originalSet = f.extensionStore.setJson;
    f.extensionStore.setJson = async options => {
        if (options.key === KEY) { entered(); await new Promise(resolve => { resolveFirst = resolve; }); }
        await originalSet(options);
    };
    const first = f.store.put(KEY, record(0), { expected: null });
    await started;
    await f.store.put('current-other', record(1), { expected: null });
    resolveFirst();
    await first;
    assert.equal(f.files.size, 2);
});

test('write is awaited and failed readback never reports a successful save', async () => {
    const f = fixture();
    f.extensionStore.setJson = async () => {};
    await assert.rejects(f.store.put(KEY, record(0), { expected: null }), code('STORY_CURRENT_WRITE_VERIFY_FAILED'));
    f.extensionStore.setJson = async options => { f.files.set(location(KEY), { different: options.value.version }); };
    await assert.rejects(f.store.put(KEY, record(0), { expected: null }), code('STORY_CURRENT_WRITE_VERIFY_FAILED'));
    const stored = await f.store.get(KEY);
    f.extensionStore.setJson = async () => { throw Error('write denied'); };
    await assert.rejects(f.store.put(KEY, record(0), { expected: stored }), error => error.code === 'STORY_CURRENT_WRITE_FAILED' && error.cause.message === 'write denied');
    f.extensionStore.setJson = async options => { f.files.set(location(KEY), structuredClone(options.value)); };
    await f.store.put(KEY, record(0), { expected: stored });
    assert.deepEqual(await f.store.get(KEY), record(0), 'failed puts must release the local write lock');
});

test('available checks API capability without I/O and get/put await host readiness', async () => {
    const f = fixture();
    assert.equal(f.store.available(), true);
    assert.equal(f.reads.length, 0);
    let resolveReady;
    f.host.__TAURITAVERN__.ready = new Promise(resolve => { resolveReady = resolve; });
    const pending = f.store.put(KEY, record(0), { expected: null });
    await Promise.resolve();
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
    resolveReady();
    await pending;
    assert.equal(f.writes.length, 1);
    f.host.__TAURITAVERN__.ready = Promise.reject(Error('not ready'));
    await assert.rejects(f.store.get(KEY), error => error.code === 'STORY_CURRENT_STORE_UNAVAILABLE' && error.cause.message === 'not ready');
});

test('unavailable hosts and read failures remain explicit and cannot use fallback storage', async () => {
    const store = createStoryCurrentFileStore({ getHostWindow: () => ({ localStorage: { setItem() { throw Error('no fallback'); } } }) });
    assert.equal(store.available(), false);
    await assert.rejects(store.get(KEY), code('STORY_CURRENT_STORE_UNAVAILABLE'));
    await assert.rejects(store.put(KEY, record(0), { expected: null }), code('STORY_CURRENT_STORE_UNAVAILABLE'));
    const throwing = createStoryCurrentFileStore({ getHostWindow: () => { throw Error('host failed'); } });
    assert.equal(throwing.available(), false);
    await assert.rejects(throwing.get(KEY), code('STORY_CURRENT_STORE_UNAVAILABLE'));
    const f = fixture();
    f.extensionStore.tryGetJson = async () => { throw Error('read denied'); };
    await assert.rejects(f.store.get(KEY), error => error.code === 'STORY_CURRENT_READ_FAILED' && error.cause.message === 'read denied');
    await assert.rejects(f.store.put(KEY, record(0), { expected: null }), code('STORY_CURRENT_READ_FAILED'));
    assert.equal(f.writes.length, 0);
});

test('only current-record safe keys can access the separate current table', async () => {
    const f = fixture();
    for (const key of ['../current-a', 'h-deadbeef', 'sha256:abc', 'current-', 'current-a.json', `current-${'a'.repeat(101)}`, 1]) {
        await assert.rejects(f.store.get(key), code('STORY_CURRENT_INVALID_KEY'));
        await assert.rejects(f.store.put(key, record(0), { expected: null }), code('STORY_CURRENT_INVALID_KEY'));
    }
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
});

test('invalid JSON, unsupported array properties and accessors are refused without invoking getters', async () => {
    const f = fixture(), cyclic = {};
    cyclic.self = cyclic;
    const sparse = []; sparse.length = 1;
    const custom = [1]; custom.extra = 2;
    const hidden = {}; Object.defineProperty(hidden, 'private', { value: 1 });
    let getters = 0;
    const accessor = {}; Object.defineProperty(accessor, 'read', { enumerable: true, get() { getters++; return 1; } });
    for (const value of [null, [], { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: () => 1 }, { value: new Date() }, cyclic, { value: sparse }, { value: custom }, hidden, accessor, { [Symbol('key')]: 1 }]) {
        await assert.rejects(f.store.put(KEY, value, { expected: null }), code('STORY_CURRENT_INVALID_JSON'));
    }
    await assert.rejects(f.store.put(KEY, record(0), { expected: [] }), code('STORY_CURRENT_INVALID_JSON'));
    const options = {}; Object.defineProperty(options, 'expected', { get() { getters++; return null; } });
    await assert.rejects(f.store.put(KEY, record(0), options), code('STORY_CURRENT_EXPECTED_REQUIRED'));
    assert.equal(getters, 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
});

test('malformed host responses and invalid stored data are never treated as missing records', async () => {
    const f = fixture();
    for (const response of [null, {}, { found: 'yes' }, { found: true }]) {
        f.extensionStore.tryGetJson = async () => response;
        await assert.rejects(f.store.get(KEY), code('STORY_CURRENT_INVALID_RESPONSE'));
    }
    f.extensionStore.tryGetJson = async () => ({ found: true, value: [] });
    await assert.rejects(f.store.get(KEY), code('STORY_CURRENT_STORE_CORRUPT'));
    f.extensionStore.tryGetJson = async () => ({ found: true, value: { invalid: undefined } });
    await assert.rejects(f.store.put(KEY, record(0), { expected: null }), code('STORY_CURRENT_STORE_CORRUPT'));
    assert.equal(f.writes.length, 0);
});
