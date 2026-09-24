import test from 'node:test';
import assert from 'node:assert/strict';
import { findNativeState2ModuleUrl, restoreNativeState2ToFloor, restoreExternalState2SnapshotToFloor } from '../apps/state2/native-bridge.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, ROOTS } from '../apps/state2/storage.js';
import { chatIdentity, chatPath } from '../apps/shared/operations.js';

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

function externalFixture() {
    const h = fixture(), ctx = h.context;
    ctx.chatMetadata.variables = {
        [ROOTS.characters]: '{"characters":[]}', 状态栏: '{"旧":true}', foreign: 'unchanged', otherOwned: 'native-before',
    };
    ctx.chatMetadata.LWB_RULES_V2 = { [`${ROOTS.characters}.characters`]: { ro: false }, 'otherOwned.x': { min: 1 }, 'foreign.x': { max: 5 } };
    ctx.chatMetadata.LWB_STATE_APPLIED_KEY = { 0: '<state>old</state>' };
    ctx.chatMetadata.extensions = { LittleWhiteBox: {
        stateLogV2: { version: 1, floors: {
            '-1': { signature: MIGRATION_OWNER, roots: [...OWNED_VARIABLE_ROOTS], ops: [], rules: [] },
            '0': { signature: '<state>old</state>', roots: ['otherOwned'], ops: [], rules: [] },
        } },
        stateCkptV2: { version: 1, every: 0, points: {} },
    } };
    ctx.saveMetadataDebounced = () => { ctx.saves = (ctx.saves ?? 0) + 1; };
    const native = { LWB_StateV2: { loadRulesFromMeta() { ctx.rulesReloaded = (ctx.rulesReloaded ?? 0) + 1; }, async restoreStateV2ToFloor() {
        ctx.chatMetadata.variables[ROOTS.characters] = '{"characters":[{"name":"native"}]}';
        ctx.chatMetadata.variables.otherOwned = 'native-restored';
        ctx.chatMetadata.LWB_RULES_V2[`${ROOTS.characters}.characters`] = { ro: false };
        ctx.saveMetadataDebounced();
        return { ok: true };
    } } };
    return { h, ctx, native };
}

test('external branch restore overlays Amin roots after native replay and establishes scoped native checkpoint', async () => {
    const { h, ctx, native } = externalFixture();
    const snapshot = { variables: {
        [ROOTS.characters]: '{"characters":[{"name":"external"}]}', 状态栏: '{"当前":"旧楼"}',
        otherOwned: 'must-not-override', foreign: 'must-not-override',
    }, rules: {
        [`${ROOTS.characters}.characters`]: { ro: true }, 'otherOwned.x': { min: 99 }, 'foreign.x': { max: 99 },
    } };
    const expected = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx.chat)) };
    const result = await restoreExternalState2SnapshotToFloor(0, snapshot, { context: h.getContext, host: native, expected });
    assert.equal(result.external, true);
    assert.equal(ctx.chatMetadata.variables[ROOTS.characters], snapshot.variables[ROOTS.characters]);
    assert.equal(ctx.chatMetadata.variables.状态栏, snapshot.variables.状态栏);
    assert.equal(ctx.chatMetadata.variables.otherOwned, 'native-restored');
    assert.equal(ctx.chatMetadata.variables.foreign, 'unchanged');
    assert.deepEqual(ctx.chatMetadata.LWB_RULES_V2[`${ROOTS.characters}.characters`], { ro: true });
    assert.deepEqual(ctx.chatMetadata.LWB_RULES_V2['otherOwned.x'], { min: 1 });
    assert.deepEqual(ctx.chatMetadata.LWB_RULES_V2['foreign.x'], { max: 5 });
    assert.equal(ctx.chatMetadata.LWB_STATE_APPLIED_KEY[0], '<state>old</state>');
    const lwb = ctx.chatMetadata.extensions.LittleWhiteBox;
    assert.ok(lwb.stateLogV2.floors['-1'].roots.includes('状态栏'));
    const point = lwb.stateCkptV2.points['0'];
    assert.equal(point.vars[ROOTS.characters], snapshot.variables[ROOTS.characters]);
    assert.equal(point.vars.状态栏, snapshot.variables.状态栏);
    assert.equal(point.vars.otherOwned, 'native-restored');
    assert.equal(point.vars.foreign, undefined);
    assert.equal(point.rules['foreign.x'], undefined);
    assert.equal(ctx.rulesReloaded, 1);
    assert.equal(ctx.saves, 2, 'final overlay must reset the native metadata debounce');
});

test('rule changes refresh the active LittleWhiteBox module when no public reload API exists', async () => {
    const { h, ctx, native } = externalFixture();
    delete native.LWB_StateV2.loadRulesFromMeta;
    let reloaded = 0;
    await restoreExternalState2SnapshotToFloor(0,
        { variables: { [ROOTS.characters]: '{"characters":[]}' }, rules: { [`${ROOTS.characters}.characters`]: { ro: true } } },
        { context: h.getContext, host: native, document: page(script(entry)),
            importer: async () => ({ loadRulesFromMeta() { reloaded++; } }) });
    assert.equal(reloaded, 1);
    assert.equal(ctx.chatMetadata.LWB_RULES_V2[`${ROOTS.characters}.characters`].ro, true);
});

test('missing native rule-cache loader fails before replay changes the active chat', async () => {
    const { h, ctx, native } = externalFixture();
    delete native.LWB_StateV2.loadRulesFromMeta;
    let replayed = 0;
    native.LWB_StateV2.restoreStateV2ToFloor = () => { replayed++; return { ok: true }; };
    await assert.rejects(restoreExternalState2SnapshotToFloor(0,
        { variables: { [ROOTS.characters]: '{"characters":[]}' }, rules: {} },
        { context: h.getContext, host: native, document: page(script(entry)), importer: async () => ({}) }), /规则表刷新接口/);
    assert.equal(replayed, 0);
    assert.equal(ctx.chatMetadata.variables[ROOTS.characters], '{"characters":[]}');
});

test('external restore clears a future native status root even before LittleWhiteBox owned it', async () => {
    const { h, ctx, native } = externalFixture();
    await restoreExternalState2SnapshotToFloor(0,
        { variables: { [ROOTS.characters]: '{"characters":[]}' }, rules: {} },
        { context: h.getContext, host: native });
    assert.equal(Object.hasOwn(ctx.chatMetadata.variables, '状态栏'), false);
    assert.equal(Object.hasOwn(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'].vars, '状态栏'), false);
    assert.ok(ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'].roots.includes('状态栏'));
});

test('matching native replay does not create another full checkpoint', async () => {
    const { h, ctx, native } = externalFixture();
    ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'].roots.push('状态栏', '势力资料');
    const snapshot = { variables: {
        [ROOTS.characters]: '{ "characters": [ { "name" : "native" } ] }', 状态栏: '{ "旧" : true }',
    }, rules: { [`${ROOTS.characters}.characters`]: { ro: false } } };
    const result = await restoreExternalState2SnapshotToFloor(0, snapshot, { context: h.getContext, host: native });
    assert.equal(result.baseline, 'native');
    assert.deepEqual(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points, {});
});

test('candidate generation restores only the previous floor without touching the old candidate reference', async () => {
    const { h, ctx, native } = externalFixture();
    ctx.chat.push({ name: 'Assistant', is_user: false, mes: 'old candidate', swipe_id: 0,
        extra: { amin_state_ref: 'old' }, swipe_info: [{ extra: { amin_state_ref: 'old' } }] });
    ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['1'] = {
        signature: '<state>old candidate</state>', roots: [ROOTS.characters], ops: [], rules: [],
    };
    ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['1'] = { vars: { [ROOTS.characters]: 'future' }, rules: {}, ts: 1 };
    const prior = native.LWB_StateV2.restoreStateV2ToFloor;
    native.LWB_StateV2.restoreStateV2ToFloor = async floor => {
        for (const key of Object.keys(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points)) {
            if (Number(key) > floor) delete ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[key];
        }
        return prior(floor);
    };
    const snapshot = { variables: { [ROOTS.characters]: '{"characters":[{"name":"previous"}]}' }, rules: {} };
    const result = await restoreExternalState2SnapshotToFloor(0, snapshot,
        { context: h.getContext, host: native, forGeneration: true });
    assert.equal(result.floor, 0);
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['1'], undefined);
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'].vars[ROOTS.characters], snapshot.variables[ROOTS.characters]);
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['1'].signature, '<state>old candidate</state>');
    assert.equal(ctx.chat[1].extra.amin_state_ref, 'old');
    await assert.rejects(restoreExternalState2SnapshotToFloor(1, snapshot,
        { context: h.getContext, host: native, forGeneration: true }), /前一楼/);
});

test('external restore rejects historical viewing, malformed snapshots and stale candidates before replay', async () => {
    const { h, ctx, native } = externalFixture();
    let calls = 0;
    native.LWB_StateV2.restoreStateV2ToFloor = () => { calls++; return { ok: true }; };
    ctx.chat.push({ name: 'Assistant', is_user: false, mes: 'later', swipe_id: 0 });
    const snapshot = { variables: { [ROOTS.characters]: '{"characters":[]}' }, rules: {} };
    await assert.rejects(restoreExternalState2SnapshotToFloor(0, snapshot, { context: h.getContext, host: native }), /末尾楼层/);
    await assert.rejects(restoreExternalState2SnapshotToFloor(1, { variables: [], rules: {} }, { context: h.getContext, host: native }), /变量或规则/);
    const expected = { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx.chat)) };
    ctx.chat[1].swipe_id = 1;
    await assert.rejects(restoreExternalState2SnapshotToFloor(1, snapshot, { context: h.getContext, host: native, expected }), /候选已变化/);
    assert.equal(calls, 0);
});

test('external restore does not overlay a new chat after native replay becomes stale', async () => {
    const { h, native } = externalFixture();
    let resolveReplay;
    native.LWB_StateV2.restoreStateV2ToFloor = () => new Promise(resolve => { resolveReplay = resolve; });
    const pending = restoreExternalState2SnapshotToFloor(0,
        { variables: { [ROOTS.characters]: '{"characters":[]}' }, rules: {} },
        { context: h.getContext, host: native });
    h.context = { ...h.context, chatId: 'other', chatMetadata: { variables: { [ROOTS.characters]: 'keep' } } };
    resolveReplay({ ok: true });
    assert.equal((await pending).stale, true);
    assert.equal(h.context.chatMetadata.variables[ROOTS.characters], 'keep');
});

test('external reference changes during native replay prevent the external overlay', async () => {
    const { h, ctx, native } = externalFixture();
    let resolveReplay, linked = true;
    native.LWB_StateV2.restoreStateV2ToFloor = () => new Promise(resolve => { resolveReplay = resolve; });
    const original = ctx.chatMetadata.variables[ROOTS.characters];
    const pending = restoreExternalState2SnapshotToFloor(0,
        { variables: { [ROOTS.characters]: '{"characters":[{"name":"external"}]}' }, rules: {} },
        { context: h.getContext, host: native, isCurrent: () => linked });
    linked = false; // The message reference changed without changing its text.
    resolveReplay({ ok: true });
    assert.equal((await pending).stale, true);
    assert.equal(ctx.chatMetadata.variables[ROOTS.characters], original);
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'], undefined);
});
