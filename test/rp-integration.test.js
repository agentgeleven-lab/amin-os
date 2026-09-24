import test from 'node:test';
import assert from 'node:assert/strict';

import { createCharactersService } from '../apps/characters/service.js';
import { createDiceService } from '../apps/dice/service.js';
import { createAbilityCheckService } from '../apps/effects/checks.js';
import { createEffects } from '../apps/effects/service.js';
import { empty as emptyEffects, change as changeEffects } from '../apps/effects/model.js';
import { LIBRARY_KEY } from '../apps/effects/library.js';
import { createInventoryService } from '../apps/inventory/service.js';
import { createRelationshipsService } from '../apps/relationships/service.js';
import { createTravelService } from '../apps/map/travel.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { createSavesService } from '../apps/saves/service.js';
import { chatPath } from '../apps/shared/operations.js';
import {
    KEY as SCENE_KEY,
    emptyState as emptyScene,
    emptyStore as emptySceneStore,
    transition as transitionScene,
    appendEvent as appendSceneEvent,
    readCurrentScene,
} from '../apps/scene/model.js';

const CLOCK = Object.freeze({ year: 1925, month: 1, day: 2, hour: 10, minute: 0, calendarLabel: '' });
const SKILL = Object.freeze({ id: 'skill_focus', name: '专注', reminder: '保持动作稳定。', book: '测试能力书', entryId: 'focus', ui: {} });

function ids(prefix) {
    let index = 0;
    return () => `${prefix}_${++index}`;
}

function host(metadata = {}) {
    const events = ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'];
    const handlers = new Map();
    let context = {
        chatId: 'chat-a', characterId: 0, groupId: null, characters: [{ avatar: 'card.png' }],
        chat: [{ name: '玩家', is_user: true, mes: '开始行动', swipe_id: 0 }],
        chatMetadata: metadata,
        extensionSettings: {},
        getCurrentChatId() { return this.chatId; },
        saveMetadata: async () => {}, saveSettingsDebounced: async () => {},
        eventTypes: Object.fromEntries(events.map(name => [name, name])),
        eventSource: {
            on(name, fn) { handlers.set(name, fn); },
            removeListener(name) { handlers.delete(name); },
        },
        setExtensionPrompt() {},
    };
    return {
        getContext: () => context,
        get context() { return context; },
        set context(value) { context = value; },
        handlers,
    };
}

function worldStatus(projects = { 人物: { 力量: 14 } }) {
    return JSON.stringify({ 版本: 1, 项目: projects });
}

function draft(value = '') {
    return { value, emitted: 0, dispatchEvent() { this.emitted++; }, focus() {} };
}

async function addCharacter(service, character) {
    await service.saveCharacter(character);
    return service.read().characters.find(value => value.id === character.id);
}

test('character World Status binding feeds one fixed ability roll without duplicating the numeric value', async () => {
    const h = host({ variables: { 状态栏: worldStatus() } });
    h.context.extensionSettings[LIBRARY_KEY] = { version: 1, skills: [structuredClone(SKILL)], groups: [], imported: [], trash: [] };
    const characters = createCharactersService(h.getContext, { createId: ids('character_event'), now: () => '2026-09-23T00:00:00Z' });
    await addCharacter(characters, {
        id: 'char_hero', name: '主角', kind: 'pc', notes: '',
        stats: [{ id: 'stat_strength', label: '力量', binding: '人物.力量', component: 'value', check: 'd20' }],
    });

    let draws = 0;
    const dice = createDiceService(h.getContext, { rng: () => { draws++; return 10; }, createId: ids('roll'), now: () => 1234 });
    const effects = createEffects(h.getContext);
    const checks = createAbilityCheckService(h.getContext, { dice, effects });
    const preview = checks.stage({
        skillId: SKILL.id, targetMode: 'direct', target: '', scope: '自身动作', command: '稳住动作',
        condition: '直到本次动作结束', durationMinutes: null,
    }, { characterId: 'char_hero', statId: 'stat_strength', mode: 'd20', valueMode: 'score', modifier: 0, dc: 15 });
    assert.equal(preview.value, 14);
    assert.equal(preview.config.modifier, 2);
    assert.equal(Object.hasOwn(preview.stat, 'value'), false);

    const result = await checks.roll();
    assert.equal(result.results[0].total, 12);
    assert.equal(draws, 1);
    const input = draft('我尝试稳住动作。');
    await checks.append(input);
    assert.match(input.value, /12/);
    await checks.apply();
    assert.equal(draws, 1);

    await characters.setStatValue('char_hero', 'stat_strength', 18);
    assert.equal(characters.resolveStat('char_hero', 'stat_strength').value, 18);
    assert.equal(dice.history()[0].results[0].total, 12);
    assert.equal(draws, 1);
    assert.equal(JSON.parse(h.context.chatMetadata.variables.状态栏).项目.人物.力量, 18);
    assert.equal(characters.read().characters[0].stats[0].value, undefined);

    checks.dispose(); effects.dispose(); dice.dispose(); characters.dispose();
});

test('inventory transfers and directed relationships retain stable character and ledger IDs across character edits', async () => {
    const h = host({ variables: { 状态栏: worldStatus({ 人物: { 力量: 14, 敏捷: 12 } }) } });
    const characters = createCharactersService(h.getContext, { createId: ids('char_event'), now: () => '2026-09-23T00:00:00Z' });
    const characterInput = (id, name, binding) => ({ id, name, kind: id === 'hero' ? 'pc' : 'npc', notes: '', stats: [{ id: `${id}_stat`, label: '属性', binding, component: 'value', check: 'none' }] });
    await addCharacter(characters, characterInput('hero', '阿明', '人物.力量'));
    await addCharacter(characters, characterInput('companion', '小岚', '人物.敏捷'));

    const inventory = createInventoryService(h.getContext, { createId: ids('inventory'), now: () => '2026-09-23T00:01:00Z' });
    inventory.saveItem({ ownerId: 'hero', name: '药草', quantity: 3, equipped: false, notes: '', reason: '初始物资' });
    await inventory.confirm();
    const sourceId = inventory.read().items[0].id;
    const firstLedgerId = inventory.read().ledger[0].id;
    inventory.transferItem({ id: sourceId, toOwnerId: 'companion', quantity: 1, reason: '交给同伴' });
    await inventory.confirm();
    const afterTransfer = inventory.read();
    const targetItem = afterTransfer.items.find(item => item.ownerId === 'companion');
    assert.equal(afterTransfer.items.find(item => item.id === sourceId).quantity, 2);
    assert.notEqual(targetItem.id, sourceId);
    assert.equal(afterTransfer.ledger[0].id, firstLedgerId);
    assert.deepEqual(afterTransfer.ledger.at(-1).entries.map(entry => entry.id), [sourceId, targetItem.id]);

    const relationships = createRelationshipsService(h.getContext, { createId: ids('relationship_event'), now: () => '2026-09-23T00:02:00Z' });
    relationships.saveRelationship({ id: 'rel_companion', fromId: 'hero', toId: 'companion', type: '同伴', label: '旅行伙伴', notes: '' });
    await relationships.confirm();
    await characters.saveCharacter({ ...characterInput('companion', '岚', '人物.敏捷') });

    assert.deepEqual(relationships.read().relationships[0], {
        id: 'rel_companion', fromId: 'hero', toId: 'companion', type: '同伴', label: '旅行伙伴', notes: '',
    });
    assert.equal(relationships.resolved()[0].to.name, '岚');
    assert.equal(inventory.read().items.find(item => item.id === targetItem.id).ownerId, 'companion');
    assert.equal(inventory.read().ledger[0].id, firstLedgerId);

    relationships.dispose(); inventory.dispose(); characters.dispose();
});

test('shared metadata lock blocks concurrent cross-app commits and a chat switch never reports the old save as current', async () => {
    const old = host({ variables: { 状态栏: worldStatus() } });
    let release;
    old.context.saveMetadata = () => new Promise(resolve => { release = resolve; });
    const characters = createCharactersService(old.getContext, { createId: ids('lock_char'), now: () => '2026-09-23T00:00:00Z' });
    const inventory = createInventoryService(old.getContext, { createId: ids('lock_inventory'), now: () => '2026-09-23T00:00:00Z' });
    const saving = characters.saveCharacter({ id: 'hero', name: '阿明', kind: 'pc', notes: '', stats: [] });
    assert.equal(characters.busy(), true);
    assert.throws(() => inventory.saveItem({ ownerId: 'hero', name: '钥匙', quantity: 1, equipped: false, notes: '', reason: '拾取' }), /保存|稍候/);

    const oldContext = old.context;
    const newContext = { ...oldContext, chatId: 'chat-b', chat: [], chatMetadata: { variables: { 状态栏: worldStatus() }, unrelated: 'new-chat' }, saveMetadata: async () => {} };
    old.context = newContext;
    release();
    await assert.rejects(saving, /变化|原聊天/);
    assert.equal(newContext.chatMetadata.amin_os_characters_v1, undefined);
    assert.equal(oldContext.chatMetadata.amin_os_characters_v1.events.length, 1);

    old.context = oldContext;
    oldContext.saveMetadata = async () => {};
    const eventCount = oldContext.chatMetadata.amin_os_characters_v1.events.length;
    await characters.retrySave();
    assert.equal(oldContext.chatMetadata.amin_os_characters_v1.events.length, eventCount);
    assert.equal(characters.read().characters[0].id, 'hero');

    inventory.dispose(); characters.dispose();
});

test('travel commits map envelope and scene clock once; retry-save does not repeat travel or effect expiry', async () => {
    const h = host();
    const initial = transitionScene(emptyScene(), 'set-time', { clock: CLOCK, reason: '设置起点时间' });
    h.context.chatMetadata[SCENE_KEY] = appendSceneEvent(emptySceneStore(), h.context.chat,
        { op: 'set-time', state: initial.state, reason: initial.reason, details: initial.details },
        { eventId: 'scene_initial', at: '2026-09-23T00:00:00Z' });
    h.context.chatMetadata.dynamicMapV1 = { updatedAt: 100, document: createDemoDocument() };

    let effectStore = emptyEffects(); effectStore.skills = [structuredClone(SKILL)];
    effectStore = changeEffects(effectStore, h.context.chat, 'create', {
        skillId: SKILL.id, holder: '阿明', targetMode: 'direct', target: '', scope: '身体', command: '',
        condition: '30 分钟后结束', durationMinutes: 30,
    }, { clock: CLOCK });
    h.context.chatMetadata.amin_os_effects_v1 = effectStore;

    let saves = 0;
    h.context.saveMetadata = async () => { if (++saves === 1) throw Error('offline'); };
    const travel = createTravelService(h.getContext, { createId: ids('travel'), now: () => Date.parse('2026-09-23T01:00:00Z'), assertReady() {} });
    const route = travel.destinations().routes.find(item => item.nodeId === 'qingyun_sect');
    const preview = travel.stage({ nodeId: route.nodeId, edgeId: route.edgeId, methodId: travel.destinations().methodId, minutes: 45, reason: '沿山路前往宗门' });
    assert.equal(preview.summary.dueEffects.length, 1);
    assert.equal(preview.summary.dueEffects[0].after, 'expired');

    await assert.rejects(travel.confirm(), /保存失败/);
    const afterFailure = structuredClone(h.context.chatMetadata);
    assert.equal(afterFailure.dynamicMapV1.document.maps.world.currentLocation, 'qingyun_sect');
    assert.equal(readCurrentScene(h.context).clock.hour, 10);
    assert.equal(readCurrentScene(h.context).clock.minute, 45);
    assert.equal(afterFailure[SCENE_KEY].events.length, 2);
    assert.equal(afterFailure[SCENE_KEY].events.at(-1).details.dueEffects.length, 1);
    assert.equal(afterFailure.amin_os_effects_v1.events.length, 1);

    await travel.retrySave();
    assert.equal(saves, 2);
    assert.deepEqual(h.context.chatMetadata, afterFailure);
    assert.equal(h.context.chatMetadata[SCENE_KEY].events.length, 2);
    assert.equal(h.context.chatMetadata.amin_os_effects_v1.events.length, 1);
    travel.dispose();
});

test('exported state restores into a different branch tail without replacing chat, unrelated variables, or credentials', async () => {
    const source = host({
        variables: { 状态栏: worldStatus(), unrelatedVariable: 'source-kept' },
        providerCredentials: { apiKey: 'source-secret' }, foreignModule: { source: true },
    });
    const sourceCharacters = createCharactersService(source.getContext, { createId: ids('source_character'), now: () => '2026-09-23T02:00:00Z' });
    await addCharacter(sourceCharacters, { id: 'hero', name: '阿明', kind: 'pc', notes: '', stats: [] });
    await addCharacter(sourceCharacters, { id: 'companion', name: '小岚', kind: 'npc', notes: '', stats: [] });
    const sourceInventory = createInventoryService(source.getContext, { createId: ids('source_inventory'), now: () => '2026-09-23T02:01:00Z' });
    sourceInventory.saveItem({ ownerId: 'hero', name: '通行证', quantity: 1, equipped: false, notes: '', reason: '出发前取得' });
    await sourceInventory.confirm();
    const sourceItemId = sourceInventory.read().items[0].id;
    const sourceRelationships = createRelationshipsService(source.getContext, { createId: ids('source_relationship'), now: () => '2026-09-23T02:02:00Z' });
    sourceRelationships.saveRelationship({ id: 'rel_party', fromId: 'hero', toId: 'companion', type: '同伴', label: '', notes: '' });
    await sourceRelationships.confirm();
    const sourceScene = transitionScene(emptyScene(), 'set-time', { clock: CLOCK, reason: '存档时间' });
    source.context.chatMetadata[SCENE_KEY] = appendSceneEvent(emptySceneStore(), source.context.chat,
        { op: 'set-time', state: sourceScene.state, reason: sourceScene.reason, details: sourceScene.details },
        { eventId: 'source_scene', at: '2026-09-23T02:03:00Z' });
    source.context.chatMetadata.dynamicMapV1 = { updatedAt: 500, document: createDemoDocument() };

    const sourceSaves = createSavesService(source.getContext, { createId: ids('source_save'), now: () => '2026-09-23T02:04:00Z' });
    const sourceBeforeSave = structuredClone(source.context.chatMetadata);
    sourceSaves.stageSave({ name: '远行前', note: '跨聊天恢复测试' });
    assert.equal(source.context.chatMetadata.amin_os_saves_v1, undefined);
    await sourceSaves.confirm();
    const saved = sourceSaves.read().saves[0];
    const exported = sourceSaves.exportSave(saved.id);
    assert.equal(exported.includes('source-secret'), false);
    assert.equal(source.context.chatMetadata.providerCredentials.apiKey, 'source-secret');
    assert.deepEqual(source.context.chatMetadata.foreignModule, { source: true });
    assert.deepEqual(sourceBeforeSave.amin_os_characters_v1, source.context.chatMetadata.amin_os_characters_v1);

    const targetChat = [
        { name: '玩家', is_user: true, mes: '另一条时间线', swipe_id: 0, extra: { dynamic_map_message_id: 'target-floor-1' } },
        { name: '角色', is_user: false, mes: '继续前进', swipe_id: 1, extra: { dynamic_map_message_id: 'target-floor-2' } },
    ];
    const target = host({
        variables: { 状态栏: worldStatus({ 目标: { 数值: 1 } }), unrelatedVariable: 'target-kept' },
        providerCredentials: { apiKey: 'target-secret', endpoint: 'local' },
        foreignModule: { target: true },
    });
    target.context.chatId = 'chat-target'; target.context.chat = targetChat;
    target.context.extensionSettings = { providerCredentials: { token: 'global-secret' } };
    const targetSaves = createSavesService(target.getContext, { createId: ids('target_restore'), now: () => '2026-09-23T03:00:00Z' });
    targetSaves.stageImport(exported);
    assert.equal(target.context.chatMetadata.amin_os_saves_v1, undefined);
    await targetSaves.confirm();
    const targetBeforeRestore = structuredClone(target.context.chatMetadata);
    const chatBeforeRestore = structuredClone(target.context.chat);
    const restorePreview = targetSaves.stageRestore(saved.id);
    assert.ok(restorePreview.summary.warnings.some(value => value.includes('其他聊天')));
    assert.equal(target.context.chatMetadata.amin_os_characters_v1, undefined);
    await targetSaves.confirm();

    assert.deepEqual(target.context.chat, chatBeforeRestore);
    assert.deepEqual(target.context.chatMetadata.providerCredentials, { apiKey: 'target-secret', endpoint: 'local' });
    assert.deepEqual(target.context.extensionSettings.providerCredentials, { token: 'global-secret' });
    assert.equal(target.context.chatMetadata.variables.unrelatedVariable, 'target-kept');
    assert.deepEqual(target.context.chatMetadata.foreignModule, { target: true });
    assert.equal(JSON.parse(target.context.chatMetadata.variables.状态栏).项目.人物.力量, 14);
    assert.equal(target.context.chatMetadata.dynamicMapV1.document.maps.world.currentLocation, 'longmen_city');
    assert.ok(Number.isFinite(target.context.chatMetadata.dynamicMapV1.updatedAt));
    assert.equal(Object.hasOwn(target.context.chatMetadata.dynamicMapV1, 'maps'), false);

    const restoredCharacters = target.context.chatMetadata.amin_os_characters_v1;
    const restoredInventory = target.context.chatMetadata.amin_os_inventory_v1;
    const restoredRelationships = target.context.chatMetadata.amin_os_relationships_v1;
    for (const event of [restoredCharacters.events.at(-1), restoredInventory.events.at(-1), restoredRelationships.events.at(-1), target.context.chatMetadata[SCENE_KEY].events.at(-1)]) {
        assert.equal(event.path.length, targetChat.length);
        assert.deepEqual(event.path, chatPath(targetChat));
        assert.ok(event.path.every(value => /^sha256:[0-9a-f]{64}$/u.test(value)));
        assert.notDeepEqual(event.path, chatPath(source.context.chat));
        assert.ok(event.path.every(value => !value.includes('另一条时间线')));
        assert.ok(event.path.every(value => !value.includes('开始行动')));
    }
    assert.deepEqual(restoredCharacters.events.at(-1).snapshot.characters.map(value => value.id), ['hero', 'companion']);
    assert.equal(restoredInventory.events.at(-1).state.items[0].id, sourceItemId);
    assert.deepEqual(restoredRelationships.events.at(-1).snapshot.relationships[0], {
        id: 'rel_party', fromId: 'hero', toId: 'companion', type: '同伴', label: '', notes: '',
    });
    assert.deepEqual(target.context.chatMetadata.dynamicMapPositionHistoryV1.sequence, ['target-floor-1:0', 'target-floor-2:1']);
    assert.equal(targetSaves.read().backups.length, 1);
    assert.equal(targetSaves.read().backups[0].modules.status.项目.目标.数值, 1);
    assert.equal(targetSaves.read().saves[0].source.identity, saved.source.identity);
    assert.equal(JSON.stringify(targetSaves.read()).includes('target-secret'), false);
    assert.deepEqual(targetBeforeRestore.providerCredentials, target.context.chatMetadata.providerCredentials);

    targetSaves.dispose(); sourceSaves.dispose(); sourceRelationships.dispose(); sourceInventory.dispose(); sourceCharacters.dispose();
});

test('save import and snapshot creation refuse unknown versions without pruning original data', async () => {
    const h = host({
        variables: { 状态栏: worldStatus() },
        amin_os_characters_v1: { version: 2, events: [], futureField: { keep: true } },
        unrelated: { keep: true },
    });
    const saves = createSavesService(h.getContext, { createId: ids('invalid_save'), now: () => '2026-09-23T04:00:00Z' });
    const before = structuredClone(h.context.chatMetadata);
    assert.throws(() => saves.stageSave({ name: '不应建立', note: '' }), /版本|不兼容/);
    assert.deepEqual(h.context.chatMetadata, before);

    const validShell = {
        format: 'amin-os-save', version: 2, id: 'future', name: '未来版本', note: '', createdAt: '2026-09-23T04:00:00Z',
        source: { identity: 'future-chat', floor: 0, candidate: 0 }, modules: {},
    };
    assert.throws(() => saves.stageImport(JSON.stringify(validShell)), /版本|不兼容/);
    assert.deepEqual(h.context.chatMetadata, before);

    const modules = Object.fromEntries(['characters', 'inventory', 'relationships', 'scene', 'effects', 'journal', 'dice', 'map', 'status', 'organizations', 'information', 'informationLibrary'].map(name => [name, null]));
    modules.characters = { version: 2, characters: [] };
    const futureModule = { ...validShell, version: 1, id: 'future-module', modules };
    assert.throws(() => saves.stageImport(JSON.stringify(futureModule)), /版本|不兼容/);
    assert.deepEqual(h.context.chatMetadata, before);
    assert.equal(saves.preview(), null);
    saves.dispose();
});
