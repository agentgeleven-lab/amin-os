import test from 'node:test';
import assert from 'node:assert/strict';
import * as Characters from '../apps/characters/model.js';
import * as Relationships from '../apps/relationships/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Journal from '../apps/journal/model.js';
import * as Effects from '../apps/effects/model.js';
import { materialize } from '../apps/saves/adapters.js';
import { migrateState2, projectState2, manualState2Patches, ROOTS } from '../apps/state2/storage.js';

const copy = value => structuredClone(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function apply(ctx, patches) {
  for (const patch of patches) {
    let target = ctx.chatMetadata;
    for (const key of patch.path.slice(0, -1)) target = target[key] ??= {};
    if (patch.remove) delete target[patch.path.at(-1)];
    else target[patch.path.at(-1)] = copy(patch.value);
  }
}
function fixture(mode) {
  const at = '2026-10-10T00:00:00.000Z';
  const ctx = { chatId: 'normalization', getCurrentChatId() { return this.chatId; },
    chat: [{ mes: 'original source', name: 'User', is_user: true }],
    characterId: 0, characters: [{ avatar: 'normalization.png' }],
    extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    chatMetadata: { variables: { Foreign: 'keep' }, unrelated: { keep: true } }, saveMetadataDebounced() {},
  };
  ctx.chatMetadata[Characters.KEY] = Characters.buildRestore(ctx, { version: 1, characters: [
    { id: 'alice', name: 'Alice', kind: 'npc', notes: '', stats: [], appearance: { description: 'person', hairstyle: '', features: '' } },
    { id: 'bob', name: 'Bob', kind: 'npc', notes: '', stats: [] },
  ] }, { id: 'characters-seed', at });
  ctx.chatMetadata[Relationships.KEY] = Relationships.buildRestore(ctx, { ...Relationships.emptyState(), relationships: [
    { id: 'ally', fromId: 'alice', toId: 'bob', type: 'ally', label: '', notes: '' },
  ] }, { id: 'relationships-seed', at });
  const scene = Scene.emptyState();
  scene.scenes.room = Scene.validateScene({ id: 'room', name: 'Room', participantIds: ['alice'] });
  scene.activeSceneId = 'room';
  ctx.chatMetadata[Scene.KEY] = Scene.appendEvent(Scene.emptyStore(), ctx.chat,
    { op: 'restore', reason: 'seed', state: scene }, { eventId: 'scene-seed', at });
  ctx.chatMetadata[Journal.KEY] = Journal.change(Journal.empty(), ctx.chat, 'create',
    { id: 'fact', kind: 'fact', title: 'Fact', body: 'Retain the original body', enabled: false, sources: null }, 'journal-seed', at);
  ctx.chatMetadata[Effects.KEY] = Effects.empty();
  apply(ctx, migrateState2(ctx).patches);
  if (mode === 'current-v1') ctx.chatMetadata.amin_os_current_story_v1 = {
    version: 1, owner: 'amin-os/current-story-v1', chat: 'normalization', key: 'current-normalization',
  };
  else ctx.chatMetadata.amin_os_story_storage_v2 = { version: 2, owner: 'amin-os/story-v2', baseStateId: 'sha256:' + 'a'.repeat(64) };
  for (const root of Object.values(ROOTS)) if (ctx.chatMetadata.variables[root] !== undefined)
    ctx.chatMetadata.variables[root] = JSON.stringify(sorted(JSON.parse(ctx.chatMetadata.variables[root])));
  return ctx;
}
function rewrite(ctx, module, update) {
  const root = ROOTS[module], value = JSON.parse(ctx.chatMetadata.variables[root]);
  update(value); ctx.chatMetadata.variables[root] = JSON.stringify(sorted(value));
}
function assertSettled(ctx) {
  const native = copy(ctx.chatMetadata.variables);
  const result = projectState2(ctx);
  apply(ctx, result.patches);
  const after = copy(ctx.chatMetadata);
  for (let n = 0; n < 3; n++) assert.deepEqual(projectState2(ctx), { patches: [], changed: [] });
  assert.deepEqual(ctx.chatMetadata, after, 'unchanged projection neither appends events nor changes time/IDs');
  assert.deepEqual(ctx.chatMetadata.variables, native, 'projection must retain the native strings exactly');
  assert.deepEqual(ctx.chatMetadata.unrelated, { keep: true });
  return result;
}

for (const mode of ['external-v2', 'current-v1']) {
  test(`${mode}: sorted nested snapshot keys settle all four app views and allow unrelated manual effects`, () => {
    const ctx = fixture(mode), before = copy(ctx.chatMetadata);
    assertSettled(ctx);
    assert.deepEqual(ctx.chatMetadata, before, 'object ordering alone must never produce a write');
    assert.doesNotThrow(() => manualState2Patches(ctx, [{ path: [Effects.KEY], value: copy(ctx.chatMetadata[Effects.KEY]) }]));
  });

  test(`${mode}: sparse optional defaults use the effective restored view without changing native content`, () => {
    const ctx = fixture(mode);
    rewrite(ctx, 'characters', value => { delete value.characters[0].notes; delete value.characters[0].appearance.hairstyle; delete value.characters[0].appearance.features; });
    rewrite(ctx, 'relationships', value => { delete value.relationships[0].label; delete value.relationships[0].notes; });
    rewrite(ctx, 'scene', value => { value.scenes.room = { id: 'room', name: 'Room', participantIds: ['alice'] }; });
    rewrite(ctx, 'journal', value => { delete value.entries[0].actors; delete value.entries[0].gameTime; delete value.entries[0].gameTimeText; delete value.entries[0].sourceNote; });
    assertSettled(ctx);
    const views = materialize(ctx);
    assert.equal(views.characters.characters[0].notes, '');
    assert.equal(views.scene.scenes.room.weather, '');
    assert.equal(views.journal.entries[0].body, 'Retain the original body');
    assert.doesNotThrow(() => manualState2Patches(ctx, [{ path: [Effects.KEY], value: copy(ctx.chatMetadata[Effects.KEY]) }]));
  });

  test(`${mode}: stale journal provenance remains safely disabled and converges after restore`, () => {
    const ctx = fixture(mode);
    const old = copy(ctx.chat); old[0].mes = 'different source branch';
    rewrite(ctx, 'journal', value => { value.entries[0].enabled = true; value.entries[0].sources = Journal.sourceFromRange(old, 0, 0); });
    const result = assertSettled(ctx);
    assert.ok(result.changed.includes('journal'));
    const entry = materialize(ctx).journal.entries[0];
    assert.equal(entry.enabled, false); assert.equal(entry.sources, null);
    assert.equal(entry.body, 'Retain the original body');
    assert.match(entry.sourceNote, /来源已失效/);
    const native = JSON.parse(ctx.chatMetadata.variables[ROOTS.journal]).entries[0];
    assert.equal(native.enabled, true); assert.equal(native.sources.messages[0].text, 'different source branch');
    assert.doesNotThrow(() => manualState2Patches(ctx, [{ path: [Effects.KEY], value: copy(ctx.chatMetadata[Effects.KEY]) }]));
  });

  test(`${mode}: genuine array order changes remain pending until projected`, () => {
    const ctx = fixture(mode);
    rewrite(ctx, 'characters', value => value.characters.reverse());
    assert.deepEqual(projectState2(ctx).changed, ['characters']);
    assert.throws(() => manualState2Patches(ctx, [{ path: [Effects.KEY], value: copy(ctx.chatMetadata[Effects.KEY]) }]), /未同步.*characters/);
    assertSettled(ctx);
    assert.deepEqual(materialize(ctx).characters.characters.map(person => person.id), ['bob', 'alice']);
  });

  test(`${mode}: information field normalization settles while keeping the original native spelling`, () => {
    const ctx = fixture(mode);
    rewrite(ctx, 'information', value => { value.records = [{ id: 'panel', name: 'World', kind: 'world', mode: 'forward', fields: [
      { id: 'field', category: ' category ', label: ' label ', value: 'Retain the value', status: 'known' },
    ] }]; });
    const result = assertSettled(ctx);
    assert.deepEqual(result.changed, ['information']);
    const field = materialize(ctx).information.records[0].fields[0];
    assert.equal(field.category, 'category'); assert.equal(field.label, 'label');
    const raw = JSON.parse(ctx.chatMetadata.variables[ROOTS.information]).records[0].fields[0];
    assert.equal(raw.category, ' category '); assert.equal(raw.label, ' label ');
  });
}
