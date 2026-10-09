import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_KEY } from '../apps/story-state/access.js';
import * as Characters from '../apps/characters/model.js';
import * as Inventory from '../apps/inventory/model.js';
import * as Relationships from '../apps/relationships/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Effects from '../apps/effects/model.js';
import { LIBRARY_KEY } from '../apps/effects/library.js';
import * as Journal from '../apps/journal/model.js';
import * as Information from '../apps/information/model.js';
import { materialize, validateModules } from '../apps/saves/adapters.js';

const clone = value => structuredClone(value);
const chat = () => [{ is_user: false, mes: '第一条回复', swipe_id: 0, swipes: ['第一条回复', '另一个回复'] }];
const context = modules => ({ chat: chat(), extensionSettings: {}, chatMetadata: { [STATE_KEY]: { version: 1, revision: 3, modules: clone(modules), updatedAt: '2026-10-10T00:00:00.000Z' } } });
const person = { id: 'person_1', name: '甲', kind: 'npc', stats: [], notes: '' };

test('independent app readers retain current data after Swipe and never persist synthesized events', () => {
    const ctx = context({ characters: { version: 1, characters: [person] }, inventory: Inventory.emptyState(), relationships: Relationships.emptyState(), scene: Scene.emptyState() });
    const before = JSON.stringify(ctx.chatMetadata);
    assert.deepEqual(Characters.readCharacters(ctx).characters, [person]);
    assert.equal(Inventory.readInventory(ctx).items.length, 0);
    assert.equal(Relationships.readRelationships(ctx).relationships.length, 0);
    ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = '另一个回复';
    assert.deepEqual(Characters.readCharacters(ctx).characters, [person]);
    assert.equal(Scene.readCurrentScene(ctx).activeSceneId, null);
    assert.equal(JSON.stringify(ctx.chatMetadata), before);
    assert.deepEqual(Object.keys(ctx.chatMetadata), [STATE_KEY]);
});

test('temporary model drafts override canonical reads only inside the sandbox', () => {
    const ctx = context({ characters: { version: 1, characters: [person] } });
    const sandbox = { ...ctx, chatMetadata: clone(ctx.chatMetadata) };
    sandbox.chatMetadata[Characters.KEY] = Characters.appendSnapshot(Characters.readStore(sandbox), sandbox.chat, { version: 1, characters: [{ ...person, name: '已修改' }] }, { id: 'preview_change' });
    assert.equal(Characters.readCharacters(sandbox).characters[0].name, '已修改');
    assert.equal(materialize(sandbox).characters.characters[0].name, '已修改');
    assert.equal(Characters.readCharacters(ctx).characters[0].name, '甲');
    assert.equal(ctx.chatMetadata[Characters.KEY], undefined);
});

test('independent effects retain consumed actions while current journal sources are not rewritten on Swipe', () => {
    const messages = chat(), sources = Journal.sourceFromRange(messages, 0, 0);
    const record = Journal.validateRecord({ id: 'fact_1', kind: 'fact', title: '原始资料', body: '正文', enabled: true, sources }, messages);
    const ctx = context({ effects: { version: 1, enabled: true, limit: 30000, effects: [], consumedActionIds: ['used_action'] }, journal: { version: 1, limit: 40000, entries: [record], drafts: [] } });
    ctx.chat = messages;
    const original = clone(ctx.chatMetadata);
    ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = '另一个回复';
    assert.deepEqual(Effects.consumedActionIds(Effects.readStore(ctx), ctx.chat), ['used_action']);
    assert.deepEqual(Effects.consumedActionIds(Effects.readStore(ctx), []), ['used_action']);
    const viewed = Journal.snapshotJournal(Journal.readStore(ctx), ctx.chat);
    assert.equal(viewed.entries[0].enabled, true);
    assert.deepEqual(viewed.entries[0].sources, sources);
    assert.equal(Journal.referenceState(viewed.entries[0], ctx.chat).valid, false);
    assert.deepEqual(ctx.chatMetadata, original);
});

test('information business modification records survive serialization and Swipe, then reset suppresses them', () => {
    const messages = chat(), record = { id: 'info_1', name: '甲', kind: 'person', mode: 'retcon', fields: [{ id: 'field_1', category: '身份', label: '职业', value: '教师', status: 'known' }] };
    record.baselineFields = clone(record.fields);
    let store = Information.apply(Information.empty(), messages, record);
    store = Information.apply(store, messages, { ...record, fields: [{ ...record.fields[0], value: '医生', status: 'edited' }] });
    const snapshot = Information.snapshotInformation({ chat: messages, chatMetadata: { [Information.KEY]: store } });
    assert.equal(snapshot.modificationHistory.length, 1);
    assert.equal('path' in snapshot.modificationHistory[0], false);
    const ctx = context({ information: JSON.parse(JSON.stringify(snapshot)) });
    const canonical = clone(ctx.chatMetadata);
    ctx.chat[0].swipe_id = 1; ctx.chat[0].mes = '另一个回复';
    const read = Information.read(ctx);
    assert.equal(Information.current(read, ctx.chat)[0].fields[0].value, '医生');
    assert.match(Information.compile(read, ctx.chat), /教师/);
    assert.match(Information.compile(read, ctx.chat), /医生/);
    assert.equal(Information.modificationHistory(read, ctx.chat).length, 1);
    assert.match(Information.compile(read, []), /医生/);
    const reset = Information.resetRecord(read, ctx.chat, 'info_1');
    assert.equal(Information.compile(reset, ctx.chat), '');
    assert.equal(Information.current(reset, ctx.chat)[0].fields[0].value, '教师');
    assert.deepEqual(ctx.chatMetadata, canonical);
    assert.equal(validateModules(materialize(ctx)).information.modificationHistory.length, 1);
});

test('independent world-status numeric bindings read canonical data without host variables', () => {
    const ctx = context({ characters: { version: 1, characters: [{ ...person, stats: [{ id: 'stat_1', label: '力量', binding: '甲.力量', component: 'value', check: 'none' }] }] }, status: { 版本: 1, 项目: { 甲: { 力量: 12 } } } });
    assert.equal(Characters.resolveStat(ctx, 'person_1', 'stat_1').value, 12);
    assert.equal(Characters.bindings(ctx)[0].value, 12);
    assert.equal(ctx.chatMetadata.variables, undefined);
    ctx.chatMetadata.variables = { 状态栏: JSON.stringify({ 版本: 1, 项目: { 甲: { 力量: 99 } } }) };
    assert.equal(Characters.resolveStat(ctx, 'person_1', 'stat_1').value, 12);
    assert.equal(materialize(ctx).status.项目.甲.力量, 12);
});

test('legacy imported abilities remain available without reimporting skills deleted from the shared library', () => {
    const skill = { id: 'legacy_skill_1', name: '旧能力', reminder: '保持效果', ui: { size: 'small' } };
    const ctx = context({ effects: null });
    ctx.chatMetadata.amin_os_imported_skills_v1 = [clone(skill)];
    const original = clone(ctx.chatMetadata);
    assert.deepEqual(Effects.readStore(ctx).skills, [skill]);
    assert.deepEqual(ctx.chatMetadata, original);
    ctx.extensionSettings[LIBRARY_KEY] = { version: 1, skills: [], groups: [], imported: [JSON.stringify(skill)], trash: [{ skill: clone(skill), at: '2026-10-10T00:00:00Z' }] };
    assert.deepEqual(Effects.readStore(ctx).skills, []);
    assert.equal(Effects.readStore(ctx).trash[0].skill.name, '旧能力');
    assert.equal(ctx.chatMetadata.amin_os_effects_v1, undefined);
});
