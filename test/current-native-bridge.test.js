import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCurrentStoryState } from '../apps/state2/current-native-bridge.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, ROOTS } from '../apps/state2/storage.js';

function fixture() {
    let ctx = {
        chatId: 'a', characterId: 0, characters: [{ avatar: 'a.png' }],
        chat: [{ mes: 'A' }, { mes: 'B', swipe_id: 1, swipes: [null, 'B'], swipe_info: [{ extra: {} }, { extra: {} }] }],
        chatMetadata: {
            variables: { [ROOTS.characters]: '{"name":"old"}', 状态栏: '{"健康":1}', Foreign: '{"score":12}', Manual: 'safe' },
            LWB_RULES_V2: { [ROOTS.characters]: { type: 'object' }, Foreign: { type: 'object' }, Manual: { type: 'string' } },
            globalAbility: 'keep', api: 'keep',
            extensions: { foreign: { keep: true }, LittleWhiteBox: { other: true,
                stateLogV2: { version: 1, floors: {
                    '-1': { signature: MIGRATION_OWNER, rules: [], ops: [], roots: [...OWNED_VARIABLE_ROOTS], ts: 1 },
                    0: { signature: 'mixed', roots: [ROOTS.characters, 'Foreign'],
                        ops: [{ path: `${ROOTS.characters}.name`, op: 'set', value: 'historical' }, { path: 'Foreign.score', op: 'inc', delta: 1 }],
                        rules: [{ path: ROOTS.characters, rule: { type: 'object' } }, { path: 'Foreign.score', rule: { type: 'number' } }], ts: 2 },
                    1: { signature: 'onlyAmin', roots: ['状态栏'], ops: [{ path: '["状态栏"].健康', op: 'set', value: 0 }], rules: [], ts: 3 },
                } },
                stateCkptV2: { version: 1, every: 50, points: {
                    0: { vars: { [ROOTS.characters]: '{"name":"historical"}', Foreign: 'historicalForeign', Unmanaged: 'keep checkpoint' },
                        rules: { [ROOTS.characters]: { type: 'object' }, Foreign: { type: 'object' } }, ts: 4 },
                    1: { vars: { 状态栏: 'historicalStatus' }, rules: {}, ts: 5 },
                } },
            } },
        }, extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    };
    const calls = [];
    const host = { LWB_StateV2: { loadRulesFromMeta() { calls.push(structuredClone(ctx.chatMetadata.LWB_RULES_V2)); },
        restoreStateV2ToFloor() { throw Error('must never replay historical variables'); } } };
    return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, context: () => ctx, host, calls };
}
const snapshot = () => ({ variables: { [ROOTS.characters]: '{"name":"current"}', 势力资料: '{"groups":[]}' },
    rules: { [ROOTS.characters]: { type: 'object', locked: true } } });

test('current-only overlay tolerates incomplete candidates and prunes only story WAL/checkpoint payload', async () => {
    const h = fixture(), messages = structuredClone(h.ctx.chat), beforeForeign = structuredClone(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors[0]);
    const tx = await applyCurrentStoryState(snapshot(), h);
    assert.equal(tx.restored, true); assert.equal(tx.stale, false); assert.equal(tx.floor, 1); assert.equal(tx.check(), true);
    assert.deepEqual(h.ctx.chat, messages);
    assert.equal(h.ctx.chatMetadata.variables[ROOTS.characters], snapshot().variables[ROOTS.characters]);
    assert.equal(Object.hasOwn(h.ctx.chatMetadata.variables, '状态栏'), false);
    assert.equal(h.ctx.chatMetadata.variables.Foreign, '{"score":12}'); assert.equal(h.ctx.chatMetadata.variables.Manual, 'safe');
    assert.equal(h.ctx.chatMetadata.globalAbility, 'keep'); assert.equal(h.ctx.chatMetadata.api, 'keep');
    const { stateLogV2: log, stateCkptV2: ckpt } = h.ctx.chatMetadata.extensions.LittleWhiteBox;
    assert.deepEqual(log.floors[0], { ...beforeForeign, roots: ['Foreign'],
        rules: [beforeForeign.rules[1]], ops: [beforeForeign.ops[1]] });
    assert.equal(log.floors[1], undefined);
    assert.equal(log.floors['-1'].signature, MIGRATION_OWNER);
    assert.deepEqual(ckpt.points[0], { vars: { Foreign: 'historicalForeign', Unmanaged: 'keep checkpoint' }, rules: { Foreign: { type: 'object' } }, ts: 4 });
    assert.deepEqual(ckpt.points[1].vars, { ...snapshot().variables, Foreign: '{"score":12}' });
    assert.deepEqual(ckpt.points[1].rules, { ...snapshot().rules, Foreign: { type: 'object' } });
    assert.equal(h.calls.length, 1);
});

test('clearing story roots preserves unrelated live variables, global records and native history', async () => {
    const h = fixture();
    const tx = await applyCurrentStoryState({ variables: {}, rules: {} }, h);
    assert.equal(tx.changed, true);
    assert.deepEqual(h.ctx.chatMetadata.variables, { Foreign: '{"score":12}', Manual: 'safe' });
    assert.deepEqual(h.ctx.chatMetadata.LWB_RULES_V2, { Foreign: { type: 'object' }, Manual: { type: 'string' } });
    assert.equal(h.ctx.chatMetadata.extensions.LittleWhiteBox.other, true);
    assert.deepEqual(h.ctx.chatMetadata.extensions.foreign, { keep: true });
    assert.deepEqual(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1].vars, { Foreign: '{"score":12}' });
});

test('rollback restores exact field references and old rule cache after failed host save', async () => {
    const h = fixture(), metadata = h.ctx.chatMetadata, original = structuredClone(metadata);
    const vars = metadata.variables, rules = metadata.LWB_RULES_V2, log = metadata.extensions.LittleWhiteBox.stateLogV2,
        ckpt = metadata.extensions.LittleWhiteBox.stateCkptV2, originalRule = rules[ROOTS.characters];
    const tx = await applyCurrentStoryState(snapshot(), h);
    assert.equal(tx.rollback(), true);
    assert.deepEqual(metadata, original);
    assert.equal(metadata.variables, vars); assert.equal(metadata.LWB_RULES_V2, rules);
    assert.equal(metadata.LWB_RULES_V2[ROOTS.characters], originalRule);
    assert.equal(metadata.extensions.LittleWhiteBox.stateLogV2, log); assert.equal(metadata.extensions.LittleWhiteBox.stateCkptV2, ckpt);
    assert.deepEqual(h.calls[1], original.LWB_RULES_V2);
    assert.throws(() => tx.rollback(), /变化/);
});

test('rollback removes originally absent containers while preserving new unrelated values', async () => {
    const h = fixture(); h.ctx.chatMetadata = {};
    const tx = await applyCurrentStoryState({ variables: { [ROOTS.scene]: '{}' }, rules: {} }, h);
    h.ctx.chatMetadata.variables.Foreign = 'added after overlay';
    assert.equal(tx.check(), true); tx.rollback();
    assert.deepEqual(h.ctx.chatMetadata, { variables: { Foreign: 'added after overlay' } });
});

test('unchanged current baseline is not rewritten on every reopening', async () => {
    const h = fixture(); await applyCurrentStoryState(snapshot(), h);
    const before = structuredClone(h.ctx.chatMetadata);
    const tx = await applyCurrentStoryState(snapshot(), h);
    assert.equal(tx.changed, false); assert.deepEqual(h.ctx.chatMetadata, before);
});

test('existing current-tip checkpoints retain unmanaged roots and custom metadata', async () => {
    const h = fixture();
    h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1] = {
        vars: { [ROOTS.characters]: 'old', Unmanaged: 'precious' }, rules: { Unmanaged: { type: 'string' } }, custom: 'keep', ts: 55,
    };
    await applyCurrentStoryState(snapshot(), h);
    const point = h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1];
    assert.equal(point.vars.Unmanaged, 'precious'); assert.deepEqual(point.rules.Unmanaged, { type: 'string' }); assert.equal(point.custom, 'keep');
});

test('no rule change requires no module loader or native replay API', async () => {
    const h = fixture();
    const next = { variables: { [ROOTS.characters]: '{}' }, rules: { [ROOTS.characters]: h.ctx.chatMetadata.LWB_RULES_V2[ROOTS.characters] } };
    const tx = await applyCurrentStoryState(next, { context: h.context, host: {}, document: {} });
    assert.equal(tx.restored, true); tx.rollback();
});

test('missing rule loader and invalid snapshots fail before touching metadata', async () => {
    const h = fixture(), before = structuredClone(h.ctx.chatMetadata);
    await assert.rejects(applyCurrentStoryState(snapshot(), { context: h.context, host: {}, document: {} }), /页面地址/);
    for (const value of [{ variables: { Foreign: 'unsafe' }, rules: {} }, { variables: { [ROOTS.characters]: {} }, rules: {} },
        { variables: {}, rules: { Foreign: {} } }, { variables: {}, rules: { [ROOTS.characters]: [] } }]) {
        await assert.rejects(applyCurrentStoryState(value, h), /无效或非剧情/);
    }
    assert.deepEqual(h.ctx.chatMetadata, before);
});

test('unrecognized WAL schema or ownership refuses without clearing any source fields', async () => {
    for (const alter of [lwb => { lwb.stateLogV2.version = 99; }, lwb => { lwb.stateLogV2.floors[0].ops = {}; },
        lwb => { lwb.stateLogV2.floors['-1'].signature = 'somebody-else'; }, lwb => { lwb.stateCkptV2.points[0].vars = []; }]) {
        const h = fixture(); alter(h.ctx.chatMetadata.extensions.LittleWhiteBox);
        const before = structuredClone(h.ctx.chatMetadata);
        await assert.rejects(applyCurrentStoryState(snapshot(), h), /不兼容/);
        assert.deepEqual(h.ctx.chatMetadata, before);
    }
});

test('chat switch while resolving the rules loader cancels before applying to either chat', async () => {
    const h = fixture(), original = h.ctx, before = structuredClone(original.chatMetadata);
    let resolve;
    const pending = applyCurrentStoryState(snapshot(), { context: h.context, host: {},
        document: { baseURI: 'http://localhost/', scripts: [{ src: '/scripts/extensions/third-party/LittleWhiteBox/index.js' }] },
        importer: () => new Promise(done => { resolve = done; }) });
    h.ctx = { ...original, chatId: 'b', chatMetadata: { variables: { other: 'safe' } } };
    resolve({ loadRulesFromMeta() { throw Error('must not call'); } });
    assert.deepEqual(await pending, { restored: false, stale: true });
    assert.deepEqual(original.chatMetadata, before); assert.deepEqual(h.ctx.chatMetadata, { variables: { other: 'safe' } });
});

test('in-place history mutations while loading are detected before any overlay', async () => {
    const h = fixture(); let resolve;
    const pending = applyCurrentStoryState(snapshot(), { context: h.context, host: {},
        document: { baseURI: 'http://localhost/', scripts: [{ src: '/scripts/extensions/third-party/LittleWhiteBox/index.js' }] },
        importer: () => new Promise(done => { resolve = done; }) });
    h.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors[0].ops[0].value = 'new legitimate update';
    const before = structuredClone(h.ctx.chatMetadata);
    resolve({ loadRulesFromMeta() {} });
    await assert.rejects(pending, /读取期间/); assert.deepEqual(h.ctx.chatMetadata, before);
});

test('transaction check rejects owned state/history changes or a switched chat', async () => {
    for (const alter of [h => { h.ctx.chatMetadata.variables[ROOTS.characters] = 'new legitimate update'; },
        h => { h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1].vars.Foreign = 'new'; }, h => { h.ctx.chatId = 'b'; }]) {
        const h = fixture(), tx = await applyCurrentStoryState(snapshot(), h);
        alter(h); const before = structuredClone(h.ctx.chatMetadata);
        assert.throws(() => tx.check(), /变化/); assert.throws(() => tx.rollback(), /变化/);
        assert.deepEqual(h.ctx.chatMetadata, before);
    }
});

test('throwing rule loader rolls metadata back and attempts to reload the original rule cache', async () => {
    const h = fixture(), before = structuredClone(h.ctx.chatMetadata); let calls = 0;
    h.host.LWB_StateV2.loadRulesFromMeta = () => { calls++; if (calls === 1) throw Error('loader failed'); };
    await assert.rejects(applyCurrentStoryState(snapshot(), h), /loader failed/);
    assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(calls, 2);
});

test('many captures retain one synthesized baseline without duplicating unrelated roots on every floor', async () => {
    const h = fixture(); h.ctx.chatMetadata.variables.Foreign = 'x'.repeat(20000);
    const original = structuredClone(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0]);
    for (let floor = 1; floor < 102; floor++) {
        if (floor > 1) h.ctx.chat.push({ mes: `reply ${floor}` });
        await applyCurrentStoryState(snapshot(), h);
        const points = h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points;
        assert.deepEqual(Object.keys(points).sort((a, b) => Number(a) - Number(b)), ['0', String(floor)]);
        assert.equal(points[floor].vars.Foreign, h.ctx.chatMetadata.variables.Foreign);
        assert.equal(Object.values(points).filter(point => point.amin_current_baseline_v1).length, 1);
        assert.ok(JSON.stringify(points).length < 25000);
    }
    assert.deepEqual(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0], {
        ...original, vars: { Foreign: 'historicalForeign', Unmanaged: 'keep checkpoint' }, rules: { Foreign: { type: 'object' } },
    });
});

test('a native full checkpoint replacement remains intact when the bounded baseline moves', async () => {
    const h = fixture(); await applyCurrentStoryState(snapshot(), h);
    h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1] = {
        vars: { ...snapshot().variables, Foreign: 'native checkpoint', NativeOnly: 'preserve' },
        rules: { ...snapshot().rules, Foreign: { type: 'object' }, NativeOnly: { type: 'string' } }, ts: 20,
    };
    h.ctx.chat.push({ mes: 'new reply' }); await applyCurrentStoryState(snapshot(), h);
    const points = h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points;
    assert.deepEqual(points[1], { vars: { Foreign: 'native checkpoint', NativeOnly: 'preserve' },
        rules: { Foreign: { type: 'object' }, NativeOnly: { type: 'string' } }, ts: 20 });
    assert.ok(points[2].amin_current_baseline_v1);
});

test('foreign edits to a synthetic checkpoint break its receipt and preserve the edited payload', async () => {
    for (const modify of [point => { point.vars.Foreign = 'later foreign edit'; },
        point => { point.vars.NewForeign = 'added later'; }, point => { point.rules.NewForeign = { locked: true }; },
        point => { point.pluginNote = 'added by another plugin'; }, point => { point.ts = 20; }]) {
        const h = fixture(); await applyCurrentStoryState(snapshot(), h);
        const point = h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1];
        modify(point); const expected = structuredClone(point); delete expected.amin_current_baseline_v1;
        for (const root of [...OWNED_VARIABLE_ROOTS, '状态栏', '势力资料']) delete expected.vars[root];
        for (const root of [...OWNED_VARIABLE_ROOTS, '状态栏', '势力资料']) delete expected.rules[root];
        h.ctx.chat.push({ mes: 'new reply' }); await applyCurrentStoryState(snapshot(), h);
        assert.deepEqual(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[1], expected);
    }
});

test('custom foreign metadata on an otherwise story-only checkpoint is preserved', async () => {
    const h = fixture();
    h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0] = {
        vars: { [ROOTS.characters]: 'old' }, rules: {}, customPluginData: { keep: true }, ts: 15,
    };
    await applyCurrentStoryState(snapshot(), h);
    assert.deepEqual(h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0], {
        vars: {}, rules: {}, customPluginData: { keep: true }, ts: 15,
    });
});
