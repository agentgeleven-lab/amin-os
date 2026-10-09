import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { KEY as STATE_KEY, emptyState, validateState } from '../apps/story-state/schema.js';
import { createOperationService } from '../apps/shared/operations.js';
import { materialize } from '../apps/saves/adapters.js';
import * as Characters from '../apps/characters/model.js';
import * as Inventory from '../apps/inventory/model.js';
import * as Relationships from '../apps/relationships/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Effects from '../apps/effects/model.js';
import * as Journal from '../apps/journal/model.js';
import * as Information from '../apps/information/model.js';
import { createCharactersService } from '../apps/characters/service.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { createRelationshipsService } from '../apps/relationships/service.js';
import { createEffects } from '../apps/effects/service.js';
import { createSceneService } from '../apps/scene/service.js';
import { createInformation } from '../apps/information/service.js';
import { LIBRARY_KEY, emptyLibrary } from '../apps/effects/library.js';

const copy = value => structuredClone(value);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fixture() {
  const handlers = new Map(), calls = { save: 0 };
  let failSave = false;
  const library = emptyLibrary();
  library.skills.push({ id: 'skill', name: 'Shield', book: 'Rules', entryId: '1', original: 'Keep the original rule', reminder: 'Until explicitly ended' });
  const ctx = { chatId: 'independent-story', characterId: 0, characters: [{ avatar: 'independent.png' }],
    getCurrentChatId() { return this.chatId; },
    chat: [{ name: 'Hero', is_user: false, mes: 'Current response', swipes: ['Current response', 'Other response'], swipe_id: 0 }],
    extensionSettings: { [LIBRARY_KEY]: library },
    eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_SWIPED: 'swipe', MESSAGE_UPDATED: 'update', MESSAGE_DELETED: 'delete', GENERATION_AFTER_COMMANDS: 'generate', GENERATION_ENDED: 'end' },
    eventSource: { on(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
      removeListener(name, handler) { handlers.get(name)?.delete(handler); } },
    setExtensionPrompt() {}, saveSettingsDebounced() {},
    async saveMetadata() { calls.save++; if (failSave) throw Error('host disk offline'); },
    chatMetadata: { variables: { Foreign: 'keep', 状态栏: 'native value must remain untouched' },
      LWB_RULES_V2: { Foreign: { ro: true } }, extensions: { LittleWhiteBox: { foreignPayload: 'keep' } },
      world_info: 'unchanged worldbook', globalAbility: { protected: true } },
  };
  const state = emptyState({ updatedAt: '2026-10-10T00:00:00.000Z' });
  state.modules.characters = { version: 1, characters: [{ id: 'hero', name: 'Hero', kind: 'pc', notes: '', stats: [
    { id: 'hp', label: 'HP', binding: 'Hero.hp', component: 'current', check: 'none' },
    { id: 'mp', label: 'MP', binding: 'Hero.mp', component: 'current', check: 'none' },
  ] }] };
  state.modules.inventory = { ...Inventory.emptyState(), items: [{ id: 'potion', name: 'Potion', ownerId: 'hero', quantity: 3, equipped: false, notes: '' }] };
  state.modules.relationships = Relationships.emptyState();
  state.modules.scene = { ...Scene.emptyState(), clock: { year: 2026, month: 10, day: 10, hour: 10, minute: 0, calendarLabel: '' } };
  state.modules.effects = { version: 1, enabled: true, limit: 30000, effects: [], consumedActionIds: [] };
  state.modules.journal = { version: 1, limit: 40000, entries: [], drafts: [] };
  state.modules.information = { version: 1, enabled: true, limit: 40000, records: [] };
  state.modules.dice = { version: 1, rolls: [] };
  state.modules.status = { 版本: 1, 项目: { Hero: { hp: { 当前: 5, 最大: 10 }, mp: { 当前: 4, 最大: 10 } } } };
  ctx.chatMetadata[STATE_KEY] = validateState(state);
  const protectedState = copy({ variables: ctx.chatMetadata.variables, rules: ctx.chatMetadata.LWB_RULES_V2,
    extensions: ctx.chatMetadata.extensions, worldbook: ctx.chatMetadata.world_info, globalAbility: ctx.chatMetadata.globalAbility });
  const runtime = createStoryStateRuntime(() => ctx), resources = [];
  const register = resource => { resources.push(resource); return resource; };
  return { ctx, runtime, calls, register, get state() { return ctx.chatMetadata[STATE_KEY]; },
    set failSave(value) { failSave = value; },
    async emit(name, ...args) { for (const fn of [...handlers.get(name) ?? []]) await fn(...args); },
    assertProtected() {
      assert.equal(ctx.extensionSettings.LittleWhiteBox, undefined);
      assert.equal(globalThis.LWB_StateV2, undefined);
      assert.deepEqual({ variables: ctx.chatMetadata.variables, rules: ctx.chatMetadata.LWB_RULES_V2,
        extensions: ctx.chatMetadata.extensions, worldbook: ctx.chatMetadata.world_info, globalAbility: ctx.chatMetadata.globalAbility }, protectedState);
      for (const key of [Characters.KEY, Inventory.KEY, Relationships.KEY, Scene.KEY, Effects.KEY, Journal.KEY, Information.KEY])
        assert.equal(Object.hasOwn(ctx.chatMetadata, key), false, `${key} must remain an ephemeral editor adapter, not a second stored state`);
    },
    dispose() { for (const resource of resources.reverse()) resource.dispose(); runtime.destroy(); },
  };
}

test('all module readers and real generated entity operations work without a LittleWhiteBox engine', async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.ready(), true);
    assert.equal(Characters.readCharacters(f.ctx).characters[0].name, 'Hero');
    assert.equal(Inventory.readInventory(f.ctx).items[0].quantity, 3);
    assert.deepEqual(Relationships.readRelationships(f.ctx).relationships, []);
    assert.equal(Scene.readCurrentScene(f.ctx).clock.minute, 0);
    assert.deepEqual(Effects.activeEffects(Effects.readStore(f.ctx), f.ctx.chat), []);
    assert.deepEqual(Journal.snapshotJournal(Journal.readStore(f.ctx), f.ctx.chat).entries, []);
    assert.deepEqual(Information.current(Information.read(f.ctx), f.ctx.chat), []);
    assert.equal(materialize(f.ctx).status.项目.Hero.hp.当前, 5);
    const characters = f.register(createCharactersService(() => f.ctx));
    await characters.saveCharacter({ name: 'Companion', kind: 'npc', notes: '', stats: [] });
    const companion = Characters.readCharacters(f.ctx).characters.find(person => person.name === 'Companion');
    assert.match(companion.id, uuidPattern);
    const inventory = f.register(createInventoryService(() => f.ctx));
    inventory.saveItem({ name: 'Token', ownerId: companion.id, quantity: 1, equipped: false, notes: '', reason: 'Register' });
    await inventory.confirm();
    assert.match(Inventory.readInventory(f.ctx).items.find(item => item.name === 'Token').id, uuidPattern);
    const relationships = f.register(createRelationshipsService(() => f.ctx));
    relationships.stage('save', { relationship: { fromId: 'hero', toId: companion.id, type: 'ally', label: '', notes: '' } });
    await relationships.confirm();
    assert.match(Relationships.readRelationships(f.ctx).relationships[0].id, uuidPattern);
    f.assertProtected();
  } finally { f.dispose(); }
});

test('Swipe navigation and reopening never replay or rewind the canonical current state', async () => {
  const f = fixture();
  try {
    const inventory = f.register(createInventoryService(() => f.ctx));
    inventory.consumeItem({ id: 'potion', quantity: 1, reason: 'Use' }); await inventory.confirm();
    const current = copy(f.state);
    f.ctx.chat[0].swipe_id = 1; f.ctx.chat[0].mes = f.ctx.chat[0].swipes[1];
    await f.emit('swipe', 0); await f.emit('chat');
    assert.deepEqual(f.state, current);
    assert.equal(Inventory.readInventory(f.ctx).items[0].quantity, 2);
    assert.equal(Characters.readCharacters(f.ctx).characters[0].id, 'hero');
    f.assertProtected();
  } finally { f.dispose(); }
});

test('duplicate character IDs reject an entire staged state update without changing old state', () => {
  const f = fixture(), operation = f.register(createOperationService(() => f.ctx));
  try {
    const before = copy(f.ctx.chatMetadata), bad = copy(f.state);
    bad.revision++; bad.modules.characters.characters.push(copy(bad.modules.characters.characters[0]));
    bad.modules.inventory.items[0].quantity = 0;
    assert.throws(() => operation.stage({ label: 'invalid atomic replacement', patches: [{ path: [STATE_KEY], value: bad }] }), /人物编号重复|duplicate|重复/i);
    assert.deepEqual(f.ctx.chatMetadata, before);
    assert.equal(f.calls.save, 0); f.assertProtected();
  } finally { f.dispose(); }
});

test('failed inventory persistence retries the confirmed deduction without another ledger entry or revision', async () => {
  const f = fixture();
  try {
    const inventory = f.register(createInventoryService(() => f.ctx));
    f.failSave = true;
    inventory.consumeItem({ id: 'potion', quantity: 1, reason: 'Use once' });
    await assert.rejects(inventory.confirm(), /offline/);
    assert.equal(Inventory.readInventory(f.ctx).items[0].quantity, 2);
    const committed = copy(f.state), ledger = copy(Inventory.readInventory(f.ctx).ledger);
    assert.equal(ledger.length, 1);
    f.failSave = false; await inventory.retrySave();
    assert.deepEqual(f.state, committed); assert.deepEqual(Inventory.readInventory(f.ctx).ledger, ledger);
    assert.equal(f.calls.save, 2); f.assertProtected();
    assert.equal(inventory.dirty(), false);
  } finally { f.dispose(); }
});

test('failed compound action persistence retries item, stat and clock changes exactly once', async () => {
  const f = fixture();
  try {
    const effects = f.register(createEffects(() => f.ctx));
    effects.stageAction({ name: 'Heal', cost: { kind: 'item', itemId: 'potion' }, costAmount: 1,
      target: { kind: 'stat', characterId: 'hero', statId: 'hp' }, delta: 3, minutes: 10 });
    f.failSave = true; await assert.rejects(effects.confirmAction(), /offline/);
    assert.equal(Inventory.readInventory(f.ctx).items[0].quantity, 2);
    assert.equal(Characters.resolveStat(f.ctx, 'hero', 'hp').value, 8);
    assert.equal(Scene.readCurrentScene(f.ctx).clock.minute, 10);
    assert.equal(f.state.modules.inventory.items[0].quantity, 2);
    assert.equal(f.state.modules.status.项目.Hero.hp.当前, 8);
    assert.equal(f.state.modules.scene.clock.minute, 10);
    const committed = copy(f.state);
    f.failSave = false; await effects.retrySave();
    assert.deepEqual(f.state, committed);
    assert.match(effects.actionResult().text, /5 → 8/); f.assertProtected();
    assert.equal(effects.dirty(), false);
  } finally { f.dispose(); }
});

test('failed effect and direct clock persistence never creates a second effect or advances time twice', async () => {
  const f = fixture();
  try {
    const effects = f.register(createEffects(() => f.ctx));
    f.failSave = true;
    await assert.rejects(effects.mutate(effects.capture(), 'create', { skillId: 'skill', holder: 'Hero', target: 'Hero',
      scope: 'Shield', command: 'Protect', condition: 'Until explicitly ended', actionId: 'once-action' }), /offline/);
    const active = Effects.activeEffects(Effects.readStore(f.ctx), f.ctx.chat);
    assert.equal(active.length, 1); assert.match(active[0].id, uuidPattern);
    const effectCommitted = copy(f.state);
    f.failSave = false; await effects.retrySave(); assert.deepEqual(f.state, effectCommitted);
    assert.deepEqual(Effects.consumedActionIds(Effects.readStore(f.ctx), f.ctx.chat), ['once-action']);
    const scene = f.register(createSceneService(() => f.ctx));
    scene.stage('advance-time', { minutes: 7, reason: 'One transition' });
    f.failSave = true; await assert.rejects(scene.confirm(), /offline/);
    assert.equal(Scene.readCurrentScene(f.ctx).clock.minute, 7);
    assert.equal(f.state.modules.scene.clock.minute, 7, 'direct scene writes must commit canonical state before persistence');
    const clockCommitted = copy(f.state);
    f.failSave = false; await scene.retrySave(); assert.deepEqual(f.state, clockCommitted);
    assert.equal(scene.dirty(), false);
    f.assertProtected();
  } finally { f.dispose(); }
});

test('information modification audit survives independent state writes and Swipe navigation', async () => {
  const f = fixture();
  try {
    const info = f.register(createInformation(() => f.ctx));
    const record = { id: 'record', name: 'World', kind: 'world', mode: 'forward', fields: [
      { id: 'field', category: 'Facts', label: 'Role', value: 'Guard', status: 'known', sources: [] },
    ] };
    await info.save(info.capture(), store => Information.apply(store, f.ctx.chat, record, 'Initial fact'));
    assert.equal(f.state.modules.information.records[0]?.fields[0].value, 'Guard', 'legacy information service must commit the canonical module');
    record.fields[0].value = 'Healer';
    await info.save(info.capture(), store => Information.apply(store, f.ctx.chat, record, 'Confirmed change'));
    assert.equal(f.state.modules.information.records[0].fields[0].value, 'Healer');
    const history = copy(Information.modificationHistory(info.read(), f.ctx.chat));
    assert.ok(history.length > 0); assert.ok(JSON.stringify(history).includes('Guard'));
    assert.ok(JSON.stringify(history).includes('Healer'));
    const state = copy(f.state);
    f.ctx.chat[0].swipe_id = 1; f.ctx.chat[0].mes = f.ctx.chat[0].swipes[1]; await f.emit('swipe', 0);
    assert.deepEqual(f.state, state);
    assert.equal(Information.current(info.read(), f.ctx.chat)[0].fields[0].value, 'Healer');
    assert.deepEqual(Information.modificationHistory(info.read(), f.ctx.chat), history);
    f.assertProtected();
  } finally { f.dispose(); }
});
