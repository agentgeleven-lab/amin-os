import test from 'node:test';
import assert from 'node:assert/strict';
import * as Characters from '../apps/characters/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Relationships from '../apps/relationships/model.js';
import * as Journal from '../apps/journal/model.js';
import * as Information from '../apps/information/model.js';
import { materialize } from '../apps/saves/adapters.js';
import { MIGRATION_KEY, BACKUP_KEY, STORY_STORAGE_KEY, ROOTS, migrateState2, nativeState2Status, projectState2, manualState2Patches, prepareState2ManualWrite } from '../apps/state2/storage.js';

const clone = value => structuredClone(value);
const parse = value => JSON.parse(value);
const storyMarker = () => ({ version: 2, owner: 'amin-os/story-v2', baseStateId: 'sha256:' + 'a'.repeat(64) });
function apply(meta, patches) {
    for (const patch of patches) {
        let at = meta;
        for (const part of patch.path.slice(0, -1)) at = at[part] ??= {};
        if (patch.remove) delete at[patch.path.at(-1)];
        else at[patch.path.at(-1)] = clone(patch.value);
    }
}
function fixture() {
    const ctx = {
        chatId: 'chat-a', getCurrentChatId() { return this.chatId; },
        chat: [{ is_user: true, name: 'User', mes: 'start' }],
        characterId: 0, characters: [{ avatar: 'example.png' }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chatMetadata: { variables: { unrelated: 'keep' }, LWB_RULES_V2: { other: { ro: true } }, oldUnrelated: { keep: true } },
        saveMetadataDebounced() {},
    };
    const person = { id: 'alice', name: 'Alice', kind: 'npc', notes: '', stats: [] };
    ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx, { version: 1, characters: [person] }, { id: 'seed', at: '2026-09-24T00:00:00.000Z' });
    const scene = Scene.emptyState(); scene.settings.includeInContext = true;
    scene.periods = [{ name: '昼', startMinute: 0 }]; scene.timeRules.travel = 97;
    ctx.chatMetadata[Scene.KEY] = Scene.appendEvent(Scene.emptyStore(), ctx.chat,
        { op: 'restore', reason: 'seed', state: scene, details: { beforeTime: null, afterTime: null } },
        { eventId: 'scene-seed', at: '2026-09-24T00:00:00.000Z' });
    const relationships = Relationships.emptyState(); relationships.settings.includeInContext = true;
    ctx.chatMetadata[Relationships.KEY] = Relationships.buildRestore(ctx, relationships, { id: 'relation-seed', at: '2026-09-24T00:00:00.000Z' });
    return ctx;
}
function migrated() { const ctx = fixture(); apply(ctx.chatMetadata, migrateState2(ctx).patches); return ctx; }

test('migration is pure, backed up, scoped, and owns native roots at its floor', () => {
    const ctx = fixture(); ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 版本: 1, 项目: {} });
    const before = clone(ctx.chatMetadata), result = migrateState2(ctx);
    assert.deepEqual(ctx.chatMetadata, before);
    assert.equal(result.migrated, true);
    apply(ctx.chatMetadata, result.patches);
    assert.equal(nativeState2Status(ctx).owned, true);
    assert.deepEqual(ctx.chatMetadata[BACKUP_KEY].roots[Characters.KEY], before[Characters.KEY]);
    assert.equal(ctx.chatMetadata[BACKUP_KEY].nativeVariables.状态栏, before.variables.状态栏);
    assert.equal(ctx.chatMetadata[MIGRATION_KEY].sourceFloor, 0);
    assert.equal(ctx.chatMetadata.variables.unrelated, 'keep');
    const owner = ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'];
    assert.deepEqual(owner.ops, []);
    assert.ok(owner.roots.includes('状态栏') && owner.roots.includes(ROOTS.characters));
    assert.ok(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0']);
    assert.deepEqual(ctx.chatMetadata.LWB_RULES_V2.other, { ro: true });
    assert.equal(ctx.chatMetadata.LWB_RULES_V2[ROOTS.dice].ro, true);
    assert.equal(migrateState2(ctx).patches.length, 0);
});

test('story variables exclude app configuration and projection keeps it', () => {
    const ctx = migrated();
    const sceneRoot = parse(ctx.chatMetadata.variables[ROOTS.scene]);
    const relationRoot = parse(ctx.chatMetadata.variables[ROOTS.relationships]);
    for (const key of ['settings', 'periods', 'timeRules', 'absenceRules']) assert.equal(Object.hasOwn(sceneRoot, key), false);
    assert.equal(Object.hasOwn(relationRoot, 'settings'), false);
    assert.equal(Object.hasOwn(parse(ctx.chatMetadata.variables[ROOTS.information]), 'limit'), false);
    const next = parse(ctx.chatMetadata.variables[ROOTS.characters]); next.characters[0].notes = 'native';
    ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(next);
    const result = projectState2(ctx);
    assert.deepEqual(result.changed, ['characters']);
    assert.deepEqual(result.patches.map(patch => patch.path), [[Characters.KEY]]);
    apply(ctx.chatMetadata, result.patches);
    assert.equal(materialize(ctx).characters.characters[0].notes, 'native');
    assert.equal(materialize(ctx).scene.settings.includeInContext, true);
    assert.equal(materialize(ctx).scene.timeRules.travel, 97);
    assert.deepEqual(materialize(ctx).scene.periods, [{ name: '昼', startMinute: 0 }]);
});

test('repeated unchanged projection skips cloning unrelated checkpoint metadata', () => {
    const ctx = migrated();
    // The extra host field is irrelevant to app state and cannot be cloned.
    // A no-change history poll must not clone the complete metadata object.
    ctx.chatMetadata.hostCallback = () => {};
    for (let i = 0; i < 4; i++) assert.deepEqual(projectState2(ctx), { patches: [], changed: [] });
    delete ctx.chatMetadata.hostCallback;
    const next = parse(ctx.chatMetadata.variables[ROOTS.characters]); next.characters[0].notes = 'new floor';
    ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(next);
    assert.deepEqual(projectState2(ctx).changed, ['characters']);
});

test('missing native root after rollback projects empty story instead of stale metadata', () => {
    const ctx = migrated();
    delete ctx.chatMetadata.variables[ROOTS.characters];
    const result = projectState2(ctx);
    assert.deepEqual(result.changed, ['characters']);
    apply(ctx.chatMetadata, result.patches);
    assert.deepEqual(materialize(ctx).characters.characters, []);
    assert.equal(ctx.chatMetadata[BACKUP_KEY].roots[Characters.KEY].events.length, 1);
});

test('manual writes add canonical root and one current-floor checkpoint without mutating input', () => {
    const ctx = migrated(), before = clone(ctx.chatMetadata), next = Characters.readCharacters(ctx);
    next.characters[0].name = 'Manual';
    const patch = { path: [Characters.KEY], value: Characters.buildRestore(ctx, next, { id: 'manual', at: '2026-09-24T00:01:00.000Z' }) };
    const result = manualState2Patches(ctx, [patch]);
    assert.deepEqual(ctx.chatMetadata, before);
    assert.ok(result.patches.some(item => item.path[0] === 'variables' && item.path[1] === ROOTS.characters));
    assert.ok(result.patches.some(item => item.path.at(-1) === 'stateCkptV2'));
    apply(ctx.chatMetadata, [patch, ...result.patches]);
    const floor = ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'];
    assert.equal(parse(floor.vars[ROOTS.characters]).characters[0].name, 'Manual');
    assert.equal(floor.vars.unrelated, 'keep');
});

test('same-floor native A to B to A changes use distinct event IDs', () => {
    const ctx = migrated(), original = parse(ctx.chatMetadata.variables[ROOTS.characters]);
    for (const notes of ['B', 'A']) {
        const next = clone(original); next.characters[0].notes = notes;
        ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(next);
        apply(ctx.chatMetadata, projectState2(ctx).patches);
    }
    const events = ctx.chatMetadata[Characters.KEY].events;
    assert.equal(new Set(events.map(event => event.id)).size, events.length);
    assert.equal(Characters.readCharacters(ctx).characters[0].notes, 'A');
});

test('external story history keeps one current app event across native updates', () => {
    const ctx = migrated(); ctx.chatMetadata[STORY_STORAGE_KEY] = storyMarker();
    const original = parse(ctx.chatMetadata.variables[ROOTS.characters]);
    const sizes = [];
    for (const notes of ['first', 'second', 'third', 'fourth']) {
        const next = clone(original); next.characters[0].notes = notes;
        ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(next);
        const before = clone(ctx.chatMetadata), result = projectState2(ctx);
        assert.deepEqual(ctx.chatMetadata, before);
        assert.deepEqual(result.changed, ['characters']);
        apply(ctx.chatMetadata, result.patches);
        assert.equal(ctx.chatMetadata[Characters.KEY].events.length, 1);
        assert.equal(Characters.readCharacters(ctx).characters[0].notes, notes);
        sizes.push(JSON.stringify(ctx.chatMetadata[Characters.KEY]).length);
        assert.deepEqual(projectState2(ctx), { patches: [], changed: [] });
    }
    assert.ok(Math.max(...sizes) - Math.min(...sizes) < 32, 'current view size stays bounded by current content');
});

test('external history activation compacts stale app events without changing story state', () => {
    const ctx = migrated(); ctx.chatMetadata[STORY_STORAGE_KEY] = storyMarker();
    const current = materialize(ctx), at = '2026-09-24T00:02:00.000Z';
    ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx, current.characters, { id: 'duplicate', at });
    ctx.chatMetadata[Scene.KEY] = Scene.appendEvent(Scene.readStore(ctx), ctx.chat,
        { op: 'restore', reason: 'duplicate', state: current.scene, details: { beforeTime: null, afterTime: null } },
        { eventId: 'scene-duplicate', at });
    ctx.chatMetadata[Journal.KEY] = { ...Journal.empty(), events: [{ id: 'old-delete', op: 'delete', recordId: 'missing', path: Journal.path(ctx.chat), at }] };
    ctx.chatMetadata[Information.KEY] = { ...Information.empty(), history: [{ id: 'old-reset', recordId: 'missing', path: Information.path(ctx.chat), at, action: 'reset', snapshot: null }] };
    const beforeState = materialize(ctx);
    const result = projectState2(ctx);
    assert.deepEqual(result.changed, ['characters', 'scene', 'journal', 'information']);
    apply(ctx.chatMetadata, result.patches);
    const afterState = materialize(ctx);
    for (const module of ['characters', 'scene', 'information']) assert.deepEqual(afterState[module], beforeState[module]);
    assert.deepEqual(afterState.journal.entries, beforeState.journal.entries);
    assert.equal(ctx.chatMetadata[Characters.KEY].events.length, 1);
    assert.equal(ctx.chatMetadata[Scene.KEY].events.length, 1);
    assert.equal(ctx.chatMetadata[Journal.KEY].events.length, 0);
    assert.equal(ctx.chatMetadata[Information.KEY].history.length, 0);
    assert.deepEqual(projectState2(ctx), { patches: [], changed: [] });
});

test('external history manual write replaces the original app patch in one transaction', () => {
    const ctx = migrated(); ctx.chatMetadata[STORY_STORAGE_KEY] = storyMarker();
    const before = clone(ctx.chatMetadata), current = Characters.readCharacters(ctx);
    current.characters[0].notes = 'manual current view';
    const input = { path: [Characters.KEY], value: Characters.buildRestore(ctx, current,
        { id: 'manual-compact', at: '2026-09-24T00:03:00.000Z' }) };
    assert.equal(input.value.events.length, 2);
    const result = manualState2Patches(ctx, [input]);
    assert.deepEqual(ctx.chatMetadata, before);
    assert.deepEqual(result.patches.filter(patch => patch.path[0] === Characters.KEY).length, 1);
    apply(ctx.chatMetadata, [input, ...result.patches]);
    assert.equal(ctx.chatMetadata[Characters.KEY].events.length, 1);
    assert.equal(Characters.readCharacters(ctx).characters[0].notes, 'manual current view');
    assert.equal(parse(ctx.chatMetadata.variables[ROOTS.characters]).characters[0].notes, 'manual current view');
    assert.deepEqual(projectState2(ctx), { patches: [], changed: [] });
});

test('invalid external history marker never compacts existing app records', () => {
    const ctx = migrated(); ctx.chatMetadata[STORY_STORAGE_KEY] = { version: 2 };
    const before = clone(ctx.chatMetadata);
    assert.throws(() => projectState2(ctx), /存储标记不兼容/);
    assert.deepEqual(ctx.chatMetadata, before);
});

test('first manual native status write adds ownership before checkpoint', () => {
    const ctx = migrated(), patch = { path: ['variables', '状态栏'], value: JSON.stringify({ 版本: 1, 项目: {} }) };
    const extra = manualState2Patches(ctx, [patch]).patches;
    assert.ok(extra.some(item => item.path.at(-1) === 'stateLogV2'));
    assert.ok(extra.some(item => item.path.at(-1) === 'stateCkptV2'));
    apply(ctx.chatMetadata, [patch, ...extra]);
    assert.ok(ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'].roots.includes('状态栏'));
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'].vars.状态栏, patch.value);
});

test('legacy helper returns direct idempotent rollback and refuses unavailable native mode', () => {
    const ctx = migrated(), original = clone(ctx.chatMetadata);
    const next = Characters.readCharacters(ctx); next.characters[0].notes = 'manual';
    ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx, next, { id: 'manual2', at: '2026-09-24T00:02:00.000Z' });
    const rollback = prepareState2ManualWrite(ctx, [[Characters.KEY]]);
    assert.equal(parse(ctx.chatMetadata.variables[ROOTS.characters]).characters[0].notes, 'manual');
    rollback(); rollback();
    assert.equal(ctx.chatMetadata.variables[ROOTS.characters], original.variables[ROOTS.characters]);
    assert.equal(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'].vars[ROOTS.characters], original.variables[ROOTS.characters]);
    ctx.extensionSettings.LittleWhiteBox.variablesMode = '1.0';
    assert.throws(() => prepareState2ManualWrite(ctx, [[Characters.KEY]]), /2\.0/);
});

test('incompatible native internals and occupied ownership floor refuse migration unchanged', () => {
    const ctx = fixture();
    ctx.chatMetadata.extensions = { LittleWhiteBox: { stateLogV2: { version: 1, floors: { '-1': { signature: 'other', roots: [], rules: [], ops: [] } } } } };
    const before = clone(ctx.chatMetadata);
    assert.throws(() => migrateState2(ctx), /负楼层/);
    assert.deepEqual(ctx.chatMetadata, before);
    ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.version = 2;
    assert.throws(() => migrateState2(ctx), /不兼容/);
});

test('native attempts to modify app settings or dice results never enter app views', () => {
    const ctx = migrated(), baseline = clone(ctx.chatMetadata);
    ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['0'] = { signature: 'native', roots: [ROOTS.scene], rules: [], ops: [{ op: 'set', path: `${ROOTS.scene}.settings.includeInContext`, value: false }] };
    assert.throws(() => projectState2(ctx), /用户设置/);
    ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['0'].ops = [{ op: 'del', path: `${ROOTS.dice}.rolls.0.results.0.total` }];
    assert.throws(() => projectState2(ctx), /骰子结果/);
    assert.deepEqual(ctx.chatMetadata[Scene.KEY], baseline[Scene.KEY]);
});
