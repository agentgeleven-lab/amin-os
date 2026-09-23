import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { adapter as map } from '../apps/linkage/adapters/map.js';
import { adapter as organizations } from '../apps/linkage/adapters/organizations.js';
import { adapter as information } from '../apps/linkage/adapters/information.js';
import { adapter as dice } from '../apps/linkage/adapters/dice.js';
import { createMap, createNode, createEdge, validateDocument } from '../apps/map/src/core/protocol.js';
import { empty as emptyOrg, entity as orgEntity, validate as validateOrg } from '../apps/organizations/model.js';
import * as Info from '../apps/information/model.js';
import { rollBatch, formatRoll } from '../apps/dice/engine.js';
import { createOperationService } from '../apps/shared/operations.js';
import { buildReferenceIndex } from '../apps/linkage/references.js';
import { buildUnifiedPrompt } from '../apps/linkage/prompt.js';
import { KEY as LINKAGE_KEY, emptyLinkageState } from '../apps/linkage/policy.js';

const now = '2026-09-23T12:00:00.000Z', options = { operationId: 'batch-0', now };
function fixture() {
    const world = { 版本: 1, 项目: { 主角: { 生命: { 当前: 8, 最大: 10 }, 力量: 3, 地点: '城门', 清醒: true, 随身: ['钥匙'] } }, extra: 'KEEP' };
    const area = createMap('city', '城镇');
    area.nodes.gate = createNode('gate', '城门', { position: { x: 0, y: 0 }, layout: { fixed: true } });
    area.nodes.market = createNode('market', '市场', { position: { x: 160, y: 0 } });
    area.nodes.secret = createNode('secret', '隐藏地点', { discovered: false });
    area.nodes.private = createNode('private', '隐藏资料', { ai: { includeInContext: false, alias: [] } });
    area.edges = [createEdge('main_road', 'gate', 'market', { direction: 'east', distance: 2, metadata: { directionLocked: true } }), createEdge('secret_road', 'gate', 'secret')];
    area.currentLocation = 'gate';
    const org = emptyOrg(); org.organizations.guild = orgEntity('organizations', '商会'); org.organizations.guild.status = '营业';
    return {
        characterId: 0, characters: [{ avatar: 'test.png' }], getCurrentChatId: () => 'chat', extensionSettings: { privateKey: 'SECRET' },
        chat: [{ name: '玩家', is_user: true, mes: '抵达城门', swipe_id: 0, extra: { wsh_message_id: 'status_floor', amin_org_message_id: 'org_floor', dynamic_map_message_id: 'map_floor' } }],
        chatMetadata: {
            variables: { 状态栏: JSON.stringify(world), 势力资料: JSON.stringify(org), unrelated: 'KEEP' }, unrelated: { protected: true },
            world_status_hud_history_v1: { records: { previous: { state: world, savedAt: 1 } } },
            amin_os_organizations_v1: { locks: ['organizations.guild.name'], assessment: null, backups: [{ original: true }], extra: 'KEEP' },
            amin_os_organizations_history_v1: { records: { previous: { state: { doc: org, assessment: null }, savedAt: 1 } } },
            dynamicMapV1: { updatedAt: 1, document: { version: 1, activeMap: 'city', maps: { city: area } } },
            dynamicMapPositionHistoryV1: { records: { previous: { mapId: 'city', nodeId: 'gate' } }, sequence: ['previous'] },
        },
        async saveMetadata() {},
    };
}
function put(ctx, result) {
    for (const patch of result.patches) {
        let parent = ctx.chatMetadata;
        for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
        if (patch.remove) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = structuredClone(patch.value);
    }
    return ctx;
}
const change = (module, action, target, data) => ({ module, action, target, data, reason: '当前剧情已明确发生' });

test('legacy adapters return safe empty views and dice has no writable operation', () => {
    const ctx = { chatMetadata: {}, chat: [], extensionSettings: { secret: 'SECRET' } };
    assert.deepEqual(status.read(ctx), { 版本: 1, 项目: {} });
    assert.deepEqual(map.read(ctx), { version: 1, activeMap: null, maps: {} });
    assert.equal(organizations.read(ctx).doc.version, 1);
    assert.deepEqual(information.read(ctx), { version: 1, enabled: true, records: [] });
    assert.deepEqual(dice.read(ctx), { version: 1, readOnly: true, rolls: [] });
    for (const action of ['roll', 'reroll', 'set', 'delete', 'send']) assert.throws(() => dice.apply(ctx, change('dice', action, 'x', {}), options), /只读/);
});

test('status updates preserve types, unrelated values, and existing floor history without mutations', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata), chat = structuredClone(ctx.chat);
    const result = status.apply(ctx, change('status', 'adjust', '主角.生命', { delta: -3, component: 'current' }), options);
    assert.deepEqual(ctx.chatMetadata, before); assert.deepEqual(ctx.chat, chat);
    assert.deepEqual(result, status.apply(ctx, change('status', 'adjust', '主角.生命', { delta: -3, component: 'current' }), options));
    put(ctx, result);
    const state = JSON.parse(ctx.chatMetadata.variables.状态栏);
    assert.deepEqual(state.项目.主角.生命, { 当前: 5, 最大: 10 }); assert.equal(state.extra, 'KEEP');
    assert.deepEqual(ctx.chatMetadata.world_status_hud_history_v1.records.previous, before.world_status_hud_history_v1.records.previous);
    assert.deepEqual(ctx.chatMetadata.world_status_hud_history_v1.records['status_floor:0'].state, state);
    assert.equal(ctx.chatMetadata.world_status_hud_history_v1.records['status_floor:0'].savedAt, Date.parse(now));
    assert.equal(ctx.chatMetadata.variables.unrelated, 'KEEP');
    put(ctx, status.apply(ctx, change('status', 'set', '主角.随身', { value: ['钥匙', '信件'] }), options));
    assert.deepEqual(status.read(ctx).项目.主角.随身, ['钥匙', '信件']);
});

test('status rejects type changes, absent/unsafe paths, nonnumeric deltas and invalid progress atomically', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const invalid = [
        change('status', 'set', '主角.力量', { value: '十' }),
        change('status', 'set', '主角.不存在', { value: 1 }),
        change('status', 'set', '主角.constructor', { value: 1 }),
        change('status', 'adjust', '主角.生命', { delta: -9, component: 'current' }),
        change('status', 'set', '主角.生命', { value: 7, component: 'max' }),
        change('status', 'adjust', '主角.地点', { delta: 1 }),
        change('status', 'adjust', '主角.力量', { delta: '1' }),
        change('status', 'set', '主角.力量', { value: 1, allowTypeChange: true }),
        change('status', 'replace', '', { value: { 项目: {} } }),
    ];
    for (const item of invalid) { assert.throws(() => status.apply(ctx, item, options)); assert.deepEqual(ctx.chatMetadata, before); }
    ctx.chatMetadata.world_status_hud_history_v1 = { records: [] };
    assert.throws(() => status.apply(ctx, change('status', 'set', '主角.力量', { value: 4 }), options), /历史/);
});

test('status never fabricates a message ID or discards prior history when no ID exists', () => {
    const ctx = fixture(); delete ctx.chat[0].extra.wsh_message_id;
    const original = structuredClone(ctx.chatMetadata.world_status_hud_history_v1);
    const result = status.apply(ctx, change('status', 'set', '主角.地点', { value: '市场' }), options);
    assert.equal(result.patches.length, 1); put(ctx, result);
    assert.deepEqual(ctx.chatMetadata.world_status_hud_history_v1, original);
    assert.equal(ctx.chat[0].extra.wsh_message_id, undefined);
});

test('map context respects hidden places and updates validate complete cross references', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const text = JSON.stringify(map.read(ctx));
    assert.equal(text.includes('隐藏地点'), false); assert.equal(text.includes('隐藏资料'), false); assert.equal(text.includes('secret_road'), false);
    const references = buildReferenceIndex({ map: map.read(ctx), scene: { scenes: { arrival: { id: 'arrival', name: '入城', location: { mapId: 'city', nodeId: 'gate' } } } } });
    assert.ok(references.entities.some(entity => entity.id === 'map:city/gate')); assert.deepEqual(references.unresolved, []);
    const result = map.apply(ctx, change('map', 'move', 'market', { mapId: 'city' }), options);
    assert.deepEqual(ctx.chatMetadata, before); put(ctx, result);
    const doc = ctx.chatMetadata.dynamicMapV1.document; validateDocument(doc);
    assert.equal(doc.maps.city.currentLocation, 'market'); assert.equal(doc.maps.city.type, 'graph');
    assert.deepEqual(doc.maps.city.nodes.gate.position, { x: 0, y: 0 });
    assert.deepEqual(ctx.chatMetadata.dynamicMapPositionHistoryV1.records.previous, { mapId: 'city', nodeId: 'gate' });
    assert.deepEqual(ctx.chatMetadata.dynamicMapPositionHistoryV1.records['map_floor:0'], { mapId: 'city', nodeId: 'market' });
    assert.equal(ctx.chatMetadata.dynamicMapV1.updatedAt, Date.parse(now));
    put(ctx, map.apply(ctx, change('map', 'add_node', 'inn', { mapId: 'city', name: '旅店', type: 'landmark' }), { ...options, operationId: 'batch-1' }));
    put(ctx, map.apply(ctx, change('map', 'add_edge', 'inn_road', { mapId: 'city', from: 'market', to: 'inn', distance: 1 }), { ...options, operationId: 'batch-2' }));
    validateDocument(ctx.chatMetadata.dynamicMapV1.document);
    assert.equal(ctx.chatMetadata.dynamicMapV1.document.maps.city.edges.find(edge => edge.id === 'inn_road').to, 'inn');
    assert.equal(ctx.chatMetadata.variables.unrelated, 'KEEP');
});

test('map rejects undiscovered references, locked directions, invalid types and wholesale mutations', () => {
    const ctx = fixture(), before = structuredClone(ctx.chatMetadata);
    const invalid = [
        change('map', 'move', 'secret', { mapId: 'city' }),
        change('map', 'move', 'private', { mapId: 'city' }),
        change('map', 'move', 'missing', { mapId: 'city' }),
        change('map', 'update_edge', 'main_road', { mapId: 'city', direction: 'west' }),
        change('map', 'update_node', 'market', { mapId: 'city', type: 'invented_type' }),
        change('map', 'update_node', 'market', { mapId: 'city', id: 'rename' }),
        change('map', 'add_edge', 'new_road', { mapId: 'city', from: 'market', to: 'missing' }),
        change('map', 'add_edge', 'new_road', { mapId: 'city', from: 'market', to: 'market' }),
        change('map', 'add_node', 'constructor', { mapId: 'city', name: '破坏' }),
        change('map', 'add_node', 'market', { mapId: 'city', name: '重复' }),
        change('map', 'remove_node', 'market', { mapId: 'city' }),
        change('map', 'replace', 'city', { document: {} }),
    ];
    for (const item of invalid) { assert.throws(() => map.apply(ctx, item, options)); assert.deepEqual(ctx.chatMetadata, before); }
});

test('organizations preserve locks, assessment, backups and floor history while validating links', () => {
    const ctx = fixture(), original = structuredClone(ctx.chatMetadata);
    const result = organizations.apply(ctx, change('organizations', 'update', 'guild', { group: 'organizations', fields: { status: '歇业' } }), options);
    assert.deepEqual(ctx.chatMetadata, original); put(ctx, result);
    assert.equal(organizations.read(ctx).doc.organizations.guild.status, '歇业');
    assert.deepEqual(ctx.chatMetadata.amin_os_organizations_v1.locks, ['organizations.guild.name']); assert.equal(ctx.chatMetadata.amin_os_organizations_v1.extra, 'KEEP');
    assert.equal(ctx.chatMetadata.amin_os_organizations_v1.backups.length, 2);
    assert.equal(ctx.chatMetadata.amin_os_organizations_history_v1.records['org_floor:0'].state.doc.organizations.guild.status, '歇业');
    assert.deepEqual(ctx.chatMetadata.amin_os_organizations_history_v1.records.previous, original.amin_os_organizations_history_v1.records.previous);
    put(ctx, organizations.apply(ctx, change('organizations', 'create', 'district', { group: 'regions', fields: { name: '城区', controllers: [{ organization: 'guild', role: '管理', note: '公开确认' }] } }), options));
    validateOrg(organizations.read(ctx).doc); assert.equal(organizations.read(ctx).doc.regions.district.controllers[0].organization, 'guild');
    const before = structuredClone(ctx.chatMetadata);
    for (const item of [
        change('organizations', 'update', 'guild', { group: 'organizations', fields: { name: '改名' } }),
        change('organizations', 'update', 'guild', { group: 'regions', fields: { name: '迁移' } }),
        change('organizations', 'update', 'guild', { group: 'organizations', fields: { relations: [{ organization: 'missing', role: '', note: '' }] } }),
        change('organizations', 'update', 'district', { group: 'regions', fields: { parent: 'district' } }),
        change('organizations', 'create', 'guild', { group: 'alliances', fields: { name: '重复 ID' } }),
    ]) { assert.throws(() => organizations.apply(ctx, item, options)); assert.deepEqual(ctx.chatMetadata, before); }
});

test('information appends deterministic branch history with baseline/removal semantics', () => {
    const ctx = fixture();
    const seed = { id: 'panel', name: '店主', kind: 'person', mode: 'forward', fields: [{ id: 'job', category: '基本', label: '身份', value: '守卫', status: 'known' }] };
    ctx.chatMetadata[Info.KEY] = Info.apply(Info.empty(), ctx.chat, seed, '初始面板');
    ctx.chat.push({ name: '店主', is_user: false, mes: '我现在经营旅店', swipe_id: 0 });
    const before = structuredClone(ctx.chatMetadata);
    const result = information.apply(ctx, change('information', 'set_field', 'panel', { fieldId: 'job', value: '店主' }), options);
    assert.deepEqual(ctx.chatMetadata, before); assert.deepEqual(result, information.apply(ctx, change('information', 'set_field', 'panel', { fieldId: 'job', value: '店主' }), options));
    const expected = Info.apply(before[Info.KEY], ctx.chat, { ...seed, fields: [{ ...seed.fields[0], value: '店主' }] }, '当前剧情已明确发生');
    expected.history.at(-1).id = options.operationId; expected.history.at(-1).at = now;
    assert.deepEqual(result.patches[0].value, expected);
    put(ctx, result); assert.equal(information.read(ctx).records[0].fields[0].value, '店主');
    assert.throws(() => information.apply(ctx, change('information', 'set_field', 'panel', { fieldId: 'job', value: '重复' }), options), /已经应用/);
    ctx.chat.at(-1).swipe_id = 1; assert.equal(information.read(ctx).records[0].fields[0].value, '守卫');
    ctx.chat.at(-1).swipe_id = 0;
    put(ctx, information.apply(ctx, change('information', 'remove_field', 'panel', { fieldId: 'job' }), { ...options, operationId: 'batch-1' }));
    const current = information.read(ctx).records[0]; assert.deepEqual(current.fields, []); assert.deepEqual(current.removed, [{ category: '基本', label: '身份' }]);
    assert.equal(ctx.chatMetadata[Info.KEY].history.length, 3); assert.deepEqual(ctx.chatMetadata.unrelated, { protected: true });
});

test('information only creates explicit stable IDs and rejects record/schema takeover', () => {
    const ctx = fixture();
    put(ctx, information.apply(ctx, change('information', 'create', 'panel', { name: '宝石', kind: 'thing', fields: [{ id: 'color', category: '外观', label: '颜色', value: '红色' }] }), options));
    assert.equal(information.read(ctx).records[0].mode, 'forward');
    const before = structuredClone(ctx.chatMetadata);
    for (const item of [
        change('information', 'set_field', 'panel', { fieldId: 'color', value: '蓝色', mode: 'retcon' }),
        change('information', 'set_field', 'panel', { fieldId: 'missing', value: '蓝色' }),
        change('information', 'set_field', 'panel', { fieldId: 'color', status: 'edited' }),
        change('information', 'add_field', 'panel', { field: { id: 'new', category: '外观', label: '颜色', value: '蓝色' } }),
        change('information', 'create', 'other', { name: '其他', kind: 'thing', mode: 'retcon', fields: [] }),
    ]) { assert.throws(() => information.apply(ctx, item, { ...options, operationId: 'batch-next' })); assert.deepEqual(ctx.chatMetadata, before); }
});

test('dice exposes fixed outcomes with actual current message linkage and no draft/settings secrets', () => {
    const ctx = fixture(), batch = rollBatch({ formula: '1d20' }, () => 14);
    const record = { id: 'fixed', createdAt: 1, settings: batch.settings, results: batch.results, status: 'sent', pending: { private: 'SECRET' }, rerollOf: null };
    record.text = formatRoll(record); record.sent = { messageIndex: 0, messageText: ctx.chat[0].mes, at: 1 };
    ctx.chatMetadata.amin_os_dice_v1 = { version: 1, rolls: [record] };
    const before = structuredClone(ctx.chatMetadata), result = dice.read(ctx);
    assert.equal(result.rolls[0].linked, true); assert.deepEqual(result.rolls[0].results, record.results); assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.deepEqual(ctx.chatMetadata, before); ctx.chat[0].mes = '另一分支'; assert.equal(dice.read(ctx).rolls[0].linked, false);
    ctx.chatMetadata.amin_os_dice_v1.rolls.push(record); assert.throws(() => dice.read(ctx), /重复/);
});

test('legacy patches use one operation commit; failed saves retry persistence without replaying deltas', async () => {
    const ctx = fixture(); let saves = 0, offline = true;
    ctx.saveMetadata = async () => { saves++; if (offline) throw Error('offline'); };
    const api = createOperationService(() => ctx);
    const token = api.capture(status.paths);
    const result = status.apply(ctx, change('status', 'adjust', '主角.力量', { delta: 2 }), options);
    api.stage({ label: '联动状态更新', ...result }, token);
    await assert.rejects(api.confirm(), /保存失败/);
    assert.equal(status.read(ctx).项目.主角.力量, 5); const applied = structuredClone(ctx.chatMetadata);
    offline = false; await api.retrySave();
    assert.equal(saves, 2); assert.deepEqual(ctx.chatMetadata, applied); api.dispose();
});

test('all writable legacy adapters stage and commit through the shared path boundary', async () => {
    const cases = [
        [status, change('status', 'set', '主角.力量', { value: 4 })],
        [map, change('map', 'move', 'market', { mapId: 'city' })],
        [organizations, change('organizations', 'update', 'guild', { group: 'organizations', fields: { status: '闭店' } })],
        [information, change('information', 'create', 'new_panel', { name: '宝石', kind: 'thing', fields: [] })],
    ];
    for (const [adapter, item] of cases) {
        const ctx = fixture(), api = createOperationService(() => ctx), before = structuredClone(ctx.chatMetadata); let saves = 0;
        ctx.saveMetadata = async () => { saves++; };
        const token = api.capture(adapter.paths), result = adapter.apply(ctx, item, options);
        api.stage({ label: adapter.label, ...result }, token);
        assert.deepEqual(ctx.chatMetadata, before);
        await api.confirm(); assert.equal(saves, 1); assert.equal(ctx.chatMetadata.variables.unrelated, 'KEEP'); assert.deepEqual(ctx.chatMetadata.unrelated, { protected: true });
        api.dispose();
    }
});

test('malformed or future legacy data is rejected without replacement', () => {
    for (const [adapter, mutate] of [
        [status, ctx => { ctx.chatMetadata.variables.状态栏 = '{"版本":99,"项目":{}}'; }],
        [map, ctx => { ctx.chatMetadata.dynamicMapV1.document.version = 99; }],
        [organizations, ctx => { ctx.chatMetadata.variables.势力资料 = '{"version":99}'; }],
        [information, ctx => { ctx.chatMetadata[Info.KEY] = { version: 99, history: [], enabled: true, limit: 40000 }; }],
        [dice, ctx => { ctx.chatMetadata.amin_os_dice_v1 = { version: 99, rolls: [] }; }],
    ]) {
        const ctx = fixture(); mutate(ctx); const before = structuredClone(ctx.chatMetadata);
        assert.throws(() => adapter.read(ctx)); assert.deepEqual(ctx.chatMetadata, before);
    }
});

test('information prompts omit unknown/inferred values, baselines and raw sources without losing local data', () => {
    const ctx = fixture(), field = (id, value, status) => ({ id, category: '资料', label: id, value, status });
    const record = {
        id: 'panel', name: '当前面板', kind: 'person', mode: 'forward',
        fields: [field('known', 'CONFIRMED_VISIBLE', 'known'), field('unknown', 'UNKNOWN_SECRET_VALUE', 'unknown'), field('inferred', 'INFERRED_SECRET_VALUE', 'inferred'), field('edited', 'USER_EDIT_VISIBLE', 'edited'), field('invented', 'CONFIRMED_FICTION_VISIBLE', 'invented')],
        baselineFields: [field('baseline', 'BASELINE_SECRET_VALUE', 'known')], rawSources: ['RAW_SOURCE_SECRET'],
    };
    ctx.chatMetadata[Info.KEY] = Info.apply(Info.empty(), ctx.chat, record);
    ctx.chatMetadata[LINKAGE_KEY] = { ...emptyLinkageState(), enabled: true };
    const before = structuredClone(ctx.chatMetadata), projection = information.readForPrompt(ctx), prompt = buildUnifiedPrompt(ctx);
    for (const secret of ['UNKNOWN_SECRET_VALUE', 'INFERRED_SECRET_VALUE', 'BASELINE_SECRET_VALUE', 'RAW_SOURCE_SECRET']) {
        assert.equal(JSON.stringify(projection).includes(secret), false); assert.equal(prompt.includes(secret), false);
    }
    for (const value of ['CONFIRMED_VISIBLE', 'USER_EDIT_VISIBLE', 'CONFIRMED_FICTION_VISIBLE']) assert.ok(prompt.includes(value));
    assert.deepEqual(projection.records[0].fields.find(value => value.id === 'unknown'), { id: 'unknown', category: '资料', label: 'unknown', status: 'unknown' });
    assert.equal(projection.records[0].baselineFields, undefined); assert.equal(projection.records[0].rawSources, undefined);
    assert.ok(JSON.stringify(information.read(ctx)).includes('UNKNOWN_SECRET_VALUE')); assert.deepEqual(ctx.chatMetadata, before);
    ctx.chatMetadata[Info.KEY].enabled = false;
    assert.deepEqual(information.readForPrompt(ctx).records, []); assert.equal(buildUnifiedPrompt(ctx).includes('CONFIRMED_VISIBLE'), false);
});

test('dice prompt includes only sent rolls linked to the current branch while the local index retains every roll', () => {
    const ctx = fixture(), batch = rollBatch({ formula: '1d20' }, () => 14);
    const record = (id, status) => ({ id, createdAt: 1, settings: batch.settings, results: batch.results, status, text: 'FIXED_' + id, rerollOf: null });
    const linked = record('LINKED_RESULT', 'sent'); ctx.chat[0].mes += '\n' + linked.text;
    linked.sent = { messageIndex: 0, messageText: ctx.chat[0].mes, at: 1 };
    const orphan = record('OLD_BRANCH_SECRET', 'sent'); orphan.sent = { messageIndex: 0, messageText: '已被替换的消息', at: 1 };
    ctx.chatMetadata.amin_os_dice_v1 = { version: 1, rolls: [linked, orphan, record('ROLLED_SECRET', 'rolled'), record('DRAFT_SECRET', 'appended')] };
    ctx.chatMetadata[LINKAGE_KEY] = { ...emptyLinkageState(), enabled: true };
    const before = structuredClone(ctx.chatMetadata), prompt = buildUnifiedPrompt(ctx);
    assert.ok(prompt.includes('FIXED_LINKED_RESULT'));
    for (const secret of ['OLD_BRANCH_SECRET', 'ROLLED_SECRET', 'DRAFT_SECRET']) assert.equal(prompt.includes(secret), false);
    assert.equal(dice.read(ctx).rolls.length, 4); assert.equal(dice.readForPrompt(ctx).rolls.length, 1); assert.deepEqual(ctx.chatMetadata, before);
    ctx.chat[0].mes = '改写后的剧情'; assert.deepEqual(dice.readForPrompt(ctx).rolls, []);
});
