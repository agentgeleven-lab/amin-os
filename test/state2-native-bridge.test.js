import test from 'node:test';
import assert from 'node:assert/strict';
import { findNativeState2ModuleUrl, restoreNativeState2ToFloor } from '../apps/state2/native-bridge.js';

const base = 'http://localhost:8000/chat';
const entry = '/scripts/extensions/third-party/LittleWhiteBox-AsyncPresets/index.js';
const nativeHost = () => ({ LWB_StateV2: { applyText() {} } });
const script = (src, loaded = 'true') => ({ src, dataset: { tauritavernLoaded: loaded } });
const page = (...scripts) => ({ baseURI: base, scripts });
function fixture() {
    let ctx = {
        chatId: 'branch-a', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ name: 'User', is_user: true, mes: 'start', swipe_id: 0 }],
        chatMetadata: { variables: {} }, extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    };
    return { get context() { return ctx; }, set context(value) { ctx = value; }, getContext: () => ctx };
}

test('finds the unique active same-origin LittleWhiteBox entry, including a reverse-proxy prefix', () => {
    const doc = { baseURI: 'https://host.example/st/chat', scripts: [
        script('https://foreign.example/scripts/extensions/third-party/LittleWhiteBox/index.js'),
        script('https://host.example/st/scripts/extensions/third-party/LittleWhiteBox/index.js', 'false'),
        script('/st/scripts/extensions/third-party/xiaobai-os-async-presets/index.js?v=1'),
    ] };
    assert.equal(findNativeState2ModuleUrl({ document: doc }),
        'https://host.example/st/scripts/extensions/third-party/xiaobai-os-async-presets/modules/variables/state2/index.js');
});

test('rejects missing, ambiguous and foreign extension entries', () => {
    assert.throws(() => findNativeState2ModuleUrl({ document: page(script('https://other.example' + entry)) }), /未找到/);
    assert.throws(() => findNativeState2ModuleUrl({ document: page(script(entry), script('/scripts/extensions/third-party/xiaobai-os/index.js')) }), /多个/);
    assert.throws(() => findNativeState2ModuleUrl({ document: page(script('/scripts/extensions/third-party/amin-os/index.js')) }), /未找到/);
});

test('custom desktop schemes compare protocol and host when URL.origin is null', () => {
    const doc = { baseURI: 'tauri://localhost/chat', scripts: [
        script('file:///scripts/extensions/third-party/LittleWhiteBox/index.js'),
        script('tauri://other/scripts/extensions/third-party/LittleWhiteBox/index.js'),
        script('tauri://localhost/scripts/extensions/third-party/LittleWhiteBox/index.js'),
    ] };
    assert.equal(findNativeState2ModuleUrl({ document: doc }),
        'tauri://localhost/scripts/extensions/third-party/LittleWhiteBox/modules/variables/state2/index.js');
});

test('uses a future public replay API before looking for a module script', async () => {
    const h = fixture(), calls = [];
    const result = await restoreNativeState2ToFloor(0, {
        context: h.getContext, host: { LWB_StateV2: { restoreStateV2ToFloor: async floor => { calls.push(floor); return { ok: true }; } } },
        document: page(), importer: () => { throw Error('should not import'); },
    });
    assert.deepEqual(calls, [0]);
    assert.equal(result.source, 'global');
    assert.equal(result.restored, true);
});

test('imports only the located native module and checks context immediately before replay', async () => {
    const h = fixture(), calls = [];
    const result = await restoreNativeState2ToFloor(0, {
        context: h.getContext, host: nativeHost(), document: page(script(entry)),
        importer: async url => {
            calls.push(url);
            return { restoreStateV2ToFloor: floor => { calls.push(floor); return { ok: true }; } };
        },
    });
    assert.deepEqual(calls, ['http://localhost:8000/scripts/extensions/third-party/LittleWhiteBox-AsyncPresets/modules/variables/state2/index.js', 0]);
    assert.equal(result.restored, true);
});

test('a chat switch during module loading cancels replay without invoking LittleWhiteBox', async () => {
    const h = fixture();
    let resolveImport, called = 0;
    const pending = restoreNativeState2ToFloor(0, {
        context: h.getContext, host: nativeHost(), document: page(script(entry)),
        importer: () => new Promise(resolve => { resolveImport = resolve; }),
    });
    h.context = { ...h.context, chatId: 'branch-b', chatMetadata: { variables: {} } };
    resolveImport({ restoreStateV2ToFloor() { called++; return { ok: true }; } });
    assert.deepEqual(await pending, { restored: false, stale: true, source: 'module' });
    assert.equal(called, 0);
});

test('a changed swipe or message during module loading cancels replay', async () => {
    const h = fixture();
    let resolveImport, called = 0;
    const pending = restoreNativeState2ToFloor(0, {
        context: h.getContext, host: nativeHost(), document: page(script(entry)),
        importer: () => new Promise(resolve => { resolveImport = resolve; }),
    });
    h.context.chat[0].swipe_id = 1;
    resolveImport({ restoreStateV2ToFloor() { called++; return { ok: true }; } });
    assert.equal((await pending).stale, true);
    assert.equal(called, 0);
});

test('invalid floors and missing native export fail without replay', async () => {
    const h = fixture();
    await assert.rejects(restoreNativeState2ToFloor(1, { context: h.getContext }), /目标楼层无效/);
    await assert.rejects(restoreNativeState2ToFloor(0, { context: h.getContext, host: nativeHost(), document: page(script(entry)), importer: async () => ({}) }), /没有原生楼层回放函数/);
    await assert.rejects(restoreNativeState2ToFloor(0, { context: h.getContext, host: {}, document: page(script(entry)) }), /接口尚未加载/);
});
