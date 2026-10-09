import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { createCurrentStoryStorage, CURRENT_STORY_KEY } from '../apps/state2/current-story-storage.js';
import { ROOTS, projectState2, manualState2Patches } from '../apps/state2/storage.js';
import { createEffects } from '../apps/effects/service.js';
import * as Effects from '../apps/effects/model.js';
import * as Characters from '../apps/characters/model.js';
import * as Scene from '../apps/scene/model.js';

// All runtime hooks and file writes stay in this fixture. This is production
// integration coverage, not proof from a running TauriTavern installation.
const clone = value => structuredClone(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function apply(metadata, patches) {
  for (const patch of patches) {
    let parent = metadata;
    for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
    if (patch.remove) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = clone(patch.value);
  }
}
async function fixture() {
  let saves = 0;
  const records = new Map();
  const ctx = {
    chatId: 'effect-projection', getCurrentChatId() { return this.chatId; }, characterId: 0, characters: [{ avatar: 'projection.png' }],
    chat: [{ name: 'User', is_user: true, mes: 'Keep the original prose.', swipe_id: 0 }],
    extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    chatMetadata: { integrity: 'projection-fixture', variables: { Foreign: '{ "z": 1, "a": 2 }', Manual: 'preserve raw' },
      LWB_RULES_V2: { Foreign: { type: 'object', ro: true } } },
    async saveMetadata() { saves++; }, saveMetadataDebounced() {},
    setExtensionPrompt() {},
  };
  ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx,
    { version: 1, characters: [{ id: 'alice', name: 'Alice', kind: 'npc', notes: '', stats: [] }] },
    { id: 'character-seed', at: '2026-10-10T00:00:00.000Z' });
  const initial = { ...Effects.empty(), skills: [{ id: 'skill', name: '持续效果', original: 'original skill', reminder: 'remain until released' }] };
  ctx.chatMetadata[Effects.KEY] = Effects.change(initial, ctx.chat, 'create',
    { skillId: 'skill', holder: 'Alice', target: 'Bob', scope: 'vision', command: 'darkness', condition: 'until released' },
    { createId: () => 'active-effect', at: '2026-10-10T00:00:00.000Z' });
  const host = { LWB_StateV2: { applyText() { throw Error('must not replay model state'); }, loadRulesFromMeta() {} } };
  const files = { available: () => true, async get(key) { return clone(records.get(key) ?? null); },
    async put(key, value, { expected }) { assert.deepEqual(records.get(key) ?? null, expected); records.set(key, clone(value)); } };
  const current = createCurrentStoryStorage(() => ctx, { files, host });
  const runtime = createState2Runtime(() => ctx, { host, document: {}, interval: 0, currentStoryStorage: current });
  await runtime.migrate();
  // Reproduce the canonical key order written by the current-variable file,
  // including sparse valid scenes whose model reader supplies default fields.
  for (const root of Object.values(ROOTS)) {
    if (ctx.chatMetadata.variables[root] !== undefined) ctx.chatMetadata.variables[root] = JSON.stringify(sorted(JSON.parse(ctx.chatMetadata.variables[root])));
  }
  ctx.chatMetadata.variables[ROOTS.scene] = JSON.stringify(sorted({ version: 1, clock: null,
    scenes: { room: { id: 'room', name: 'Room' } }, activeSceneId: 'room', schedules: [] }));
  // This fixture injection stands in for an accepted native update; otherwise
  // the current-only protection correctly restores its earlier saved state.
  runtime.acceptCurrentStoryWrite(ctx);
  const effects = createEffects(() => ctx);
  return { ctx, runtime, effects, records, get saves() { return saves; }, dispose() { effects.dispose(); runtime.destroy(); } };
}

test('canonical sorted native JSON and sparse scene defaults converge after one projection', async () => {
  const f = await fixture();
  try {
    const raw = clone(f.ctx.chatMetadata.variables), first = projectState2(f.ctx);
    assert.ok(first.changed.includes('scene'));
    apply(f.ctx.chatMetadata, first.patches);
    assert.deepEqual(projectState2(f.ctx), { patches: [], changed: [] });
    for (let n = 0; n < 5; n++) assert.equal(f.runtime.sync(), false);
    assert.deepEqual(f.ctx.chatMetadata.variables, raw, 'view hydration must not rewrite native raw strings');
    const scene = Scene.readCurrentScene(f.ctx).scenes.room;
    assert.equal(scene.weather, ''); assert.deepEqual(scene.participantIds, []); assert.equal(scene.gameTime, null);
  } finally { f.dispose(); }
});

for (const operation of ['end', 'delete']) {
  test(`actual ability ${operation} saves through operation/runtime guards after sorted canonical hydration`, async () => {
    const f = await fixture();
    try {
      const bodies = clone(f.ctx.chat);
      const rawOthers = Object.fromEntries(Object.entries(f.ctx.chatMetadata.variables).filter(([root]) => root !== ROOTS.effects));
      const savesBefore = f.saves;
      f.runtime.sync();
      assert.deepEqual(projectState2(f.ctx).changed, []);
      assert.equal(Effects.activeEffects(f.effects.read(), f.ctx.chat).length, 1);
      const token = f.effects.capture();
      await f.effects.mutate(token, operation, { id: 'active-effect', ...(operation === 'end' ? { reason: 'manual release' } : {}) });
      assert.equal(Effects.activeEffects(f.effects.read(), f.ctx.chat).length, 0);
      assert.equal(JSON.parse(f.ctx.chatMetadata.variables[ROOTS.effects]).effects.length, 0);
      assert.deepEqual(f.effects.read().skills.map(skill => skill.id), ['skill']);
      assert.ok(f.saves > savesBefore);
      assert.deepEqual(f.ctx.chat, bodies);
      for (const [root, raw] of Object.entries(rawOthers)) assert.equal(f.ctx.chatMetadata.variables[root], raw, `unrelated raw root changed: ${root}`);
      assert.deepEqual(projectState2(f.ctx).changed, []);
      assert.equal(f.runtime.sync(), false);
      assert.equal(f.runtime.ready(), true);
      const saved = f.records.get(f.ctx.chatMetadata[CURRENT_STORY_KEY].key);
      assert.equal(saved.current.state.variables[ROOTS.effects].effects.length, 0);
    } finally { f.dispose(); }
  });
}

test('a real unprojected character change still prevents editing another module', async () => {
  const f = await fixture();
  try {
    apply(f.ctx.chatMetadata, projectState2(f.ctx).patches);
    const characters = JSON.parse(f.ctx.chatMetadata.variables[ROOTS.characters]);
    characters.characters[0].name = 'Actually changed';
    f.ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(sorted(characters));
    assert.deepEqual(projectState2(f.ctx).changed, ['characters']);
    const before = clone(f.ctx.chatMetadata), effects = f.effects.read();
    const next = Effects.change(effects, f.ctx.chat, 'end', { id: 'active-effect', reason: 'release' });
    assert.throws(() => manualState2Patches(f.ctx, [{ path: [Effects.KEY], value: next }]), /未同步.*characters/);
    assert.deepEqual(f.ctx.chatMetadata, before);
    assert.equal(Effects.activeEffects(f.effects.read(), f.ctx.chat).length, 1);
  } finally { f.dispose(); }
});
