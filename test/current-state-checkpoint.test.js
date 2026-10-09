import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointState, registerCurrentCheckpointWrite } from '../apps/status/state-checkpoint.js';
import { applyCurrentStoryState } from '../apps/state2/current-native-bridge.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, ROOTS } from '../apps/state2/storage.js';

function fixture(currentOnly = true) {
    const identity = JSON.stringify([['character', 0], 'a']);
    let saves = 0;
    const ctx = { chatId: 'a', characterId: 0, chat: [{ mes: 'start' }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } }, saveMetadataDebounced() { saves++; },
        chatMetadata: { variables: { [ROOTS.characters]: '{}', Foreign: 'important' }, LWB_RULES_V2: {},
            abilityLibrary: ['keep'], worldbooks: ['keep'], apiProfiles: ['keep'],
            ...(currentOnly ? { amin_os_current_story_v1: { version: 1, owner: 'amin-os/current-story-v1', chat: identity, key: 'current/a' } } : {}),
            extensions: { LittleWhiteBox: {
                stateLogV2: { version: 1, floors: { '-1': { signature: MIGRATION_OWNER, roots: [...OWNED_VARIABLE_ROOTS], rules: [], ops: [], ts: 1 },
                    0: { signature: 'foreign', roots: ['Foreign'], ops: [], rules: [], ts: 2 } } },
                stateCkptV2: { version: 1, every: 50, points: { 0: { vars: { Foreign: 'original native checkpoint' }, rules: {}, ts: 3 } } },
            } },
        },
    };
    return { ctx, saves: () => saves };
}

test('current-only manual checkpoint preparation leaves metadata untouched for transactional compaction', () => {
    const h = fixture(), before = structuredClone(h.ctx.chatMetadata);
    assert.equal(checkpointState(h.ctx), false);
    assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(h.saves(), 0);
});

test('explicit current-only frontend writes signal their exact source context without making a checkpoint', () => {
    const h = fixture(), before = structuredClone(h.ctx.chatMetadata), seen = [];
    const unregister = registerCurrentCheckpointWrite(ctx => { seen.push(ctx); });
    try {
        assert.equal(checkpointState(h.ctx), false);
        assert.deepEqual(seen, [h.ctx]); assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(h.saves(), 0);
        const shadow = { ...h.ctx, chatMetadata: structuredClone(h.ctx.chatMetadata) };
        assert.equal(checkpointState(shadow), false);
        assert.equal(seen[1], shadow); assert.notEqual(seen[1].chatMetadata, h.ctx.chatMetadata);
        unregister(); checkpointState(h.ctx); assert.equal(seen.length, 2);
    } finally { unregister(); }
});

test('legacy and unrecognized modes never signal a current-only write', () => {
    const seen = [], unregister = registerCurrentCheckpointWrite(ctx => { seen.push(ctx); });
    try {
        const legacy = fixture(false); assert.equal(checkpointState(legacy.ctx), true);
        const unknown = fixture(); unknown.ctx.chatMetadata.amin_os_current_story_v1.owner = 'foreign';
        assert.equal(checkpointState(unknown.ctx), true); assert.deepEqual(seen, []);
    } finally { unregister(); }
    assert.throws(() => registerCurrentCheckpointWrite(null), /function/);
});

test('legacy manual checkpoints still include all native variables/rules and schedule their save', () => {
    const h = fixture(false); h.ctx.chatMetadata.LWB_RULES_V2.Foreign = { type: 'string' };
    assert.equal(checkpointState(h.ctx), true);
    const point = h.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0];
    assert.deepEqual(point.vars, h.ctx.chatMetadata.variables); assert.deepEqual(point.rules, h.ctx.chatMetadata.LWB_RULES_V2);
    assert.equal(h.saves(), 1);
});

test('unrecognized markers do not suppress existing native checkpoint behavior', () => {
    for (const marker of [{ version: 99, owner: 'amin-os/current-story-v1' }, { version: 1, owner: 'foreign' }, null]) {
        const h = fixture(); h.ctx.chatMetadata.amin_os_current_story_v1 = marker;
        assert.equal(checkpointState(h.ctx), true); assert.equal(h.saves(), 1);
    }
});

test('manual edits across many floors keep one generated baseline and preserve unrelated native checkpoints', async () => {
    const h = fixture(), ctx = h.ctx; ctx.chatMetadata.variables.Foreign = 'large unrelated value '.repeat(2000);
    const originalPoint = structuredClone(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0]);
    for (let floor = 1; floor <= 40; floor++) {
        ctx.chat.push({ mes: `reply ${floor}` });
        ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify({ revision: floor });
        const before = structuredClone(ctx.chatMetadata);
        assert.equal(checkpointState(ctx), false); assert.deepEqual(ctx.chatMetadata, before);
        const tx = await applyCurrentStoryState({ variables: { [ROOTS.characters]: ctx.chatMetadata.variables[ROOTS.characters] }, rules: {} },
            { context: () => ctx, host: {}, document: {} });
        assert.equal(tx.check(), true);
        const points = ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points;
        assert.deepEqual(Object.keys(points).sort((a, b) => Number(a) - Number(b)), ['0', String(floor)]);
        assert.deepEqual(points[0], originalPoint);
        assert.equal(points[floor].vars[ROOTS.characters], JSON.stringify({ revision: floor }));
        assert.equal(points[floor].vars.Foreign, ctx.chatMetadata.variables.Foreign);
        assert.ok(JSON.stringify(points).length < 45000);
    }
    assert.equal(h.saves(), 0);
    assert.deepEqual(ctx.chatMetadata.abilityLibrary, ['keep']); assert.deepEqual(ctx.chatMetadata.worldbooks, ['keep']);
    assert.deepEqual(ctx.chatMetadata.apiProfiles, ['keep']);
});
