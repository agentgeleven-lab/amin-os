import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryCurrentFileStore, STORY_CURRENT_STORE_NAMESPACE, STORY_CURRENT_STORE_TABLE } from '../apps/shared/story-current-file-store.js';
import { createCurrentStoryStorage, CURRENT_STORY_KEY, currentStoryKey, validateCurrentStoryRecord } from '../apps/state2/current-story-storage.js';
import { applyCurrentStoryState } from '../apps/state2/current-native-bridge.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS, ROOTS } from '../apps/state2/storage.js';
import { chatIdentity } from '../apps/shared/operations.js';

// Production service, mutable-file adapter and native overlay are exercised
// together. The Tauri store and rule cache here are in-memory stand-ins; these
// tests never read or write the user's running host or local chat files.
const clone = value => structuredClone(value);
const owned = [...OWNED_VARIABLE_ROOTS, ...Object.values(NATIVE_VARIABLE_ROOTS)];
const stateValue = value => JSON.stringify({ revision: value });
function fixture() {
  const records = new Map(), calls = { read: 0, write: 0, ruleReload: 0 };
  let ctx = {
    chatId: 'integration-parent', characterId: 0, characters: [{ avatar: 'npc.png' }],
    extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
    chat: [{ name: 'NPC', mes: 'first original prose' },
      { name: 'NPC', mes: 'selected original prose', swipe_id: 1, swipes: [null, 'selected original prose'],
        amin_story_message_id: 'message-id', extra: { amin_story_candidate_id: 'duplicate' },
        swipe_info: [{ extra: { amin_story_candidate_id: 'duplicate' } }, { extra: { amin_story_candidate_id: 'duplicate' } }] }],
    chatMetadata: {
      integrity: 'original-integrity',
      variables: { ...Object.fromEntries(owned.map(root => [root, stateValue(0)])), Foreign: 'foreign live value' },
      LWB_RULES_V2: { ...Object.fromEntries(owned.map(root => [root, { type: 'object' }])), Foreign: { type: 'string' } },
      amin_os_story_storage_v2: { broken: 'legacy index must never be matched' },
      apiChannels: { saved: 'preserve' }, abilityLibrary: { saved: 'preserve' }, worldbooks: ['preserve'],
      extensions: { Other: { keep: true }, LittleWhiteBox: {
        stateLogV2: { version: 1, floors: {
          '-1': { signature: MIGRATION_OWNER, roots: [...owned, 'Foreign'], rules: [], ops: [], ts: 1 },
          0: { roots: [ROOTS.characters, 'Foreign'],
            rules: [{ path: ROOTS.characters, rule: { type: 'object' } }, { path: 'Foreign', rule: { type: 'string' } }],
            ops: [{ path: `${ROOTS.characters}.revision`, op: 'set', value: -1 }, { path: 'Foreign', op: 'set', value: 'historic foreign' }], ts: 2 },
        } },
        stateCkptV2: { version: 1, every: 50, points: {
          0: { vars: { [ROOTS.characters]: stateValue(-1), Foreign: 'historic foreign', Detached: 'preserve' },
            rules: { [ROOTS.characters]: { type: 'object' }, Foreign: { type: 'string' } }, ts: 3 },
        } },
      } },
    },
  };
  const store = {
    async tryGetJson({ namespace, table, key }) {
      assert.equal(namespace, STORY_CURRENT_STORE_NAMESPACE); assert.equal(table, STORY_CURRENT_STORE_TABLE);
      calls.read++; return records.has(key) ? { found: true, value: clone(records.get(key)) } : { found: false };
    },
    async setJson({ namespace, table, key, value }) {
      assert.equal(namespace, STORY_CURRENT_STORE_NAMESPACE); assert.equal(table, STORY_CURRENT_STORE_TABLE);
      calls.write++; records.set(key, clone(value));
    },
  };
  const host = { __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store } } },
    LWB_StateV2: { loadRulesFromMeta() { calls.ruleReload++; },
      restoreStateV2ToFloor() { throw Error('old floor reconstruction must never run'); } } };
  const files = createStoryCurrentFileStore({ getHostWindow: () => host });
  const context = () => ctx;
  const service = createCurrentStoryStorage(context, { files, host, document: undefined,
    restoreState: (_floor, snapshot, options) => applyCurrentStoryState(snapshot, { ...options, context, host, document: undefined }) });
  return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, context, host, files, service, records, calls,
    async apply(transaction) {
      const overlay = await applyCurrentStoryState(transaction.snapshot, { context, host, document: undefined });
      assert.equal(overlay.restored, true); assert.equal(overlay.stale, false); overlay.check();
      await transaction.verify?.(); return overlay;
    },
    stored() { return records.get(ctx.chatMetadata[CURRENT_STORY_KEY].key); },
  };
}

test('real service, file adapter and native overlay switch without resolving broken legacy Swipe candidates', async () => {
  const f = fixture(), before = clone(f.ctx);
  const tx = await f.service.switchToCurrent({ clear: false }); await f.apply(tx);
  assert.equal(f.records.size, 1); assert.equal(f.calls.write, 1);
  assert.equal(f.service.status().currentOnly, true);
  assert.equal(f.ctx.chatMetadata[CURRENT_STORY_KEY].key, currentStoryKey(chatIdentity(f.ctx)));
  assert.deepEqual(f.ctx.chat, before.chat);
  assert.deepEqual(f.ctx.chatMetadata.variables, before.chatMetadata.variables);
  assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2, before.chatMetadata.LWB_RULES_V2);
  for (const field of ['apiChannels', 'abilityLibrary', 'worldbooks', 'amin_os_story_storage_v2']) {
    assert.deepEqual(f.ctx.chatMetadata[field], before.chatMetadata[field]);
  }
  const persisted = validateCurrentStoryRecord(f.stored());
  assert.deepEqual(Object.keys(persisted.current.state.variables).sort(), owned.slice().sort());
  assert.equal(persisted.current.state.variables.Foreign, undefined);
});

test('clear backs up unsaved latest live values and removes only the 11 owned roots and rules', async () => {
  const f = fixture(); await f.apply(await f.service.enable());
  f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(999);
  f.ctx.chatMetadata.LWB_RULES_V2[`["${ROOTS.characters}"].revision`] = { type: 'number', minimum: 0 };
  const liveVariables = clone(f.ctx.chatMetadata.variables), liveRules = clone(f.ctx.chatMetadata.LWB_RULES_V2);
  const beforeBody = clone(f.ctx.chat), tx = await f.service.clearCurrent();
  assert.equal(f.ctx.chatMetadata.variables[ROOTS.characters], stateValue(999), 'file preparation alone must not erase live state');
  assert.equal(f.stored().backups[0].state.variables[ROOTS.characters].revision, 999);
  await f.apply(tx);
  assert.deepEqual(f.ctx.chatMetadata.variables, { Foreign: 'foreign live value' });
  assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2, { Foreign: { type: 'string' } });
  assert.deepEqual(f.ctx.chat, beforeBody);
  const listing = await f.service.inspectCurrentBackups();
  await f.apply(await f.service.restoreCurrentBackup(0, { expectedHash: listing.backups[0].hash }));
  assert.deepEqual(f.ctx.chatMetadata.variables, liveVariables);
  assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2, liveRules);
});

test('40 captured tip changes stay at one current file, five backups and one owned native baseline', async () => {
  const f = fixture(); await f.apply(await f.service.enable());
  const foreignPoint = clone(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points[0]);
  const foreignLog = clone(f.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors[0]);
  for (let value = 1; value <= 40; value++) {
    f.ctx.chat.push({ name: 'NPC', mes: `new prose ${value}` });
    f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(value);
    const tip = f.ctx.chat.length - 1;
    f.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors[tip] = {
      roots: [ROOTS.characters], rules: [], ops: [{ path: `${ROOTS.characters}.revision`, op: 'set', value }], ts: value,
    };
    await f.apply(await f.service.capture());
    const persisted = validateCurrentStoryRecord(f.stored());
    assert.equal(f.records.size, 1);
    assert.equal(persisted.backups.length, Math.min(value, 5));
    const native = f.ctx.chatMetadata.extensions.LittleWhiteBox;
    assert.deepEqual(native.stateLogV2.floors[0], foreignLog);
    assert.deepEqual(native.stateCkptV2.points[0], foreignPoint);
    assert.deepEqual(Object.keys(native.stateLogV2.floors).sort(), ['-1', '0']);
    assert.deepEqual(Object.keys(native.stateCkptV2.points).sort(), ['0', String(tip)].sort());
    assert.equal(native.stateCkptV2.points[tip].vars[ROOTS.characters], stateValue(value));
  }
  assert.equal(f.stored().current.state.variables[ROOTS.characters].revision, 40);
  assert.deepEqual(f.stored().backups.map(item => item.state.variables[ROOTS.characters].revision), [39, 38, 37, 36, 35]);
  assert.equal((await f.service.inspectStorage()).records, 1);
});

test('fork copies into an independent mutable key without modifying its parent', async () => {
  const f = fixture(); await f.apply(await f.service.enable());
  f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(1); await f.apply(await f.service.capture());
  const parentKey = f.ctx.chatMetadata[CURRENT_STORY_KEY].key, parent = clone(f.records.get(parentKey));
  const child = clone(f.ctx); child.chatId = 'integration-child'; child.chatMetadata.integrity = 'child-integrity'; f.ctx = child;
  const binding = await f.service.ensureIndex(); assert.equal(binding.changed, true);
  const childKey = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
  assert.notEqual(childKey, parentKey); assert.equal(f.records.size, 2);
  await f.service.restoreFloor(f.ctx.chat.length - 1);
  f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(2); await f.apply(await f.service.capture());
  assert.deepEqual(f.records.get(parentKey), parent);
  assert.equal(f.records.get(childKey).current.state.variables[ROOTS.characters].revision, 2);
  assert.equal(f.records.get(parentKey).current.state.variables[ROOTS.characters].revision, 1);
});

test('verified export rebuilds a missing record and restores without reading historical candidate identities', async () => {
  const f = fixture(); await f.apply(await f.service.enable());
  f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(7); await f.apply(await f.service.capture());
  const bundle = await f.service.exportStory(), key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
  f.records.delete(key); f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(8);
  await assert.rejects(f.service.restoreFloor(f.ctx.chat.length - 1), error => error.code === 'STORY_CURRENT_MISSING');
  await f.service.importStory(bundle);
  assert.equal(f.ctx.chatMetadata.variables[ROOTS.characters], stateValue(8), 'import must require a separate restore');
  const result = await f.service.restoreFloor(f.ctx.chat.length - 1);
  assert.equal(result.restored, true); assert.equal(f.ctx.chatMetadata.variables[ROOTS.characters], stateValue(7));
  assert.equal(f.records.size, 1);
});

test('owned corrupt record rejects normal capture and is repaired only by a verified same-chat export', async () => {
  const f = fixture(); await f.apply(await f.service.enable());
  const bundle = await f.service.exportStory(), key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
  const damaged = clone(f.records.get(key)); damaged.current.state.variables[ROOTS.characters].revision = -10;
  f.records.set(key, damaged);
  const before = clone(f.ctx);
  await assert.rejects(f.service.capture(), error => error.code === 'STORY_CURRENT_CORRUPT');
  assert.deepEqual(f.ctx, before); assert.deepEqual(f.records.get(key), damaged);
  await f.service.importStory(bundle); validateCurrentStoryRecord(f.records.get(key));
  f.ctx.chatMetadata.variables[ROOTS.characters] = stateValue(123);
  await f.service.restoreFloor(f.ctx.chat.length - 1);
  assert.equal(f.ctx.chatMetadata.variables[ROOTS.characters], stateValue(0));
  assert.equal(f.ctx.chatMetadata.variables.Foreign, 'foreign live value');
});
