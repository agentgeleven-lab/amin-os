import test from 'node:test';
import assert from 'node:assert/strict';
import { createTravelService, travelDestinations } from '../apps/map/travel.js';
import { createMap, createNode, createEdge } from '../apps/map/src/core/protocol.js';
import { defaultRules, defaultRoadTypes, defaultTypes } from '../apps/map/src/core/spatial.js';
import { createStore } from '../apps/map/src/core/store.js';
import { createDraftSession } from '../apps/map/src/core/draft.js';
import { bindChatStore } from '../apps/map/src/adapters/chat.js';
import { createVariableBridge } from '../apps/map/src/integrations/chat-variables.js';
import { registerMapRuntime, assertMapReady } from '../apps/map/src/integrations/runtime.js';
import { createOperationService } from '../apps/shared/operations.js';
import { KEY, emptyStore, emptyState, appendEvent, readCurrentScene, mapReferences } from '../apps/scene/model.js';
import { empty as emptyEffects, change as changeEffect } from '../apps/effects/model.js';

const clock = { year: 2026, month: 9, day: 23, hour: 10, minute: 0, calendarLabel: '' };
const historyKey = 'dynamicMapPositionHistoryV1';
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
    const map = createMap('town', '城镇');
    map.nodes = { a: createNode('a', '广场'), b: createNode('b', '车站'), c: createNode('c', '巷口'), hidden: createNode('hidden', '密室', { discovered: false }) };
    map.edges = [createEdge('ab', 'a', 'b', { name: '站前路', distance: 5 }), createEdge('ca', 'c', 'a', { distance: 1, bidirectional: false }), createEdge('ah', 'a', 'hidden', { distance: 1 })];
    map.currentLocation = 'a';
    map.metadata = { rules: defaultRules(), nodeTypes: defaultTypes(), roadTypes: defaultRoadTypes() };
    const state = emptyState(); state.clock = structuredClone(clock);
    let ctx = { chat: [{ name: '玩家', is_user: true, mes: '现在出发', swipe_id: 0, extra: { dynamic_map_message_id: 'msg1' } }],
        characterId: 0, characters: [{ avatar: 'hero' }], getCurrentChatId: () => 'test', extensionSettings: { dynamicMapIntegration: { variables: false, allowMoves: true } },
        chatMetadata: { unrelated: { kept: true }, dynamicMapV1: { updatedAt: 100, document: { version: 1, activeMap: 'town', maps: { town: map } } },
            [historyKey]: { sequence: ['msg1:0'], records: { 'msg1:0': { mapId: 'town', nodeId: 'a' } } } },
        saveMetadata: async () => { saves++; }, saveChat: async () => { chatSaves++; } };
    ctx.chatMetadata[KEY] = appendEvent(emptyStore(), [], { op: 'set-time', reason: '开始', details: {}, state }, { eventId: 'start', at: '2026-09-23T00:00:00Z' });
    let saves = 0, chatSaves = 0, id = 0;
    const getContext = () => ctx, service = createTravelService(getContext, { createId: () => `trip_${++id}`, now: () => 1000 });
    return { service, getContext, get ctx() { return ctx; }, set ctx(value) { ctx = value; }, get saves() { return saves; }, get chatSaves() { return chatSaves; } };
}
function mountRuntime(f) {
    const cache = new Map(), store = createStore(f.ctx.chatMetadata.dynamicMapV1.document);
    const storage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
    const persistence = bindChatStore(store, { getContext: f.getContext, storage, namespace: 'test' });
    const draft = createDraftSession(store, persistence), unregister = registerMapRuntime({ store, persistence, draft, context: f.getContext });
    return { cache, store, persistence, draft, dispose() { unregister(); draft.destroy(); persistence.destroy(); } };
}
const proposal = (extra = {}) => ({ nodeId: 'b', edgeId: 'ab', methodId: 'walk', reason: '沿站前路前往车站', ...extra });

test('real saved map envelope supplies scene references without leaking hidden locations or mutating source', () => {
    const f = setup(), before = structuredClone(f.ctx.chatMetadata);
    assert.deepEqual(mapReferences(f.ctx).map(item => item.nodeId), ['a', 'b', 'c']);
    assert.equal(mapReferences(f.ctx)[0].current, true); assert.deepEqual(f.ctx.chatMetadata, before); f.service.dispose();
});

test('known routes enforce discovery, direction, explicit passability and destination adjacency', () => {
    const f = setup(), routes = f.service.destinations().routes;
    assert.deepEqual(routes.map(route => route.nodeId), ['b', 'c']);
    assert.equal(routes[0].minutes, 60); assert.equal(routes[1].accessible, false);
    assert.throws(() => f.service.stage(proposal({ nodeId: 'c', edgeId: 'ca' })), /单向/);
    assert.throws(() => f.service.stage(proposal({ nodeId: 'hidden', edgeId: 'ah' })), /相邻道路/);
    f.ctx.chatMetadata.dynamicMapV1.document.maps.town.edges[0].metadata.blocked = true;
    assert.throws(() => f.service.stage(proposal()), /不可通行/);
    delete f.ctx.chatMetadata.dynamicMapV1.document.maps.town.edges[0].metadata.blocked;
    f.ctx.chatMetadata.dynamicMapV1.document.maps.town.nodes.b.metadata.passable = false;
    assert.throws(() => f.service.stage(proposal()), /不可通行/); f.service.dispose();
});

test('unknown time requires explicit minutes; missing legacy rules never invent speed or distance', () => {
    const f = setup(), map = f.ctx.chatMetadata.dynamicMapV1.document.maps.town;
    map.edges[0].distance = null;
    assert.throws(() => f.service.stage(proposal()), /耗时未知/);
    assert.equal(f.service.stage(proposal({ minutes: 17 })).summary.minutes, 17);
    assert.throws(() => f.service.stage(proposal({ minutes: -1 })), /整数分钟/);
    assert.throws(() => f.service.stage(proposal({ minutes: 0.3 })), /整数分钟/);
    assert.throws(() => f.service.stage(proposal({ minutes: false })), /整数分钟/);
    assert.throws(() => f.service.stage(proposal({ minutes: [] })), /整数分钟/);
    assert.throws(() => f.service.stage(proposal({ minutes: ' ' })), /耗时未知/);
    delete map.metadata.rules; delete map.metadata.nodeTypes; delete map.metadata.roadTypes;
    assert.deepEqual(travelDestinations(f.ctx).methods, []);
    assert.equal(f.service.stage(proposal({ methodId: undefined, minutes: 0 })).summary.minutes, 0); f.service.dispose();
});

test('preview is read only and atomic confirmation changes location, clock, scene and tail position once', async () => {
    const f = setup(), live = mountRuntime(f), before = structuredClone(f.ctx.chatMetadata);
    const preview = f.service.stage(proposal());
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(preview.summary.from, '广场'); assert.equal(preview.summary.to, '车站');
    assert.equal(preview.summary.beforeTime.hour, 10); assert.equal(preview.summary.afterTime.hour, 11); assert.equal(preview.summary.sceneName, '车站');
    await f.service.confirm();
    assert.equal(f.saves, 1); assert.equal(f.chatSaves, 0); assert.equal(f.ctx.chatMetadata.dynamicMapV1.document.maps.town.currentLocation, 'b');
    const scene = readCurrentScene(f.ctx); assert.equal(scene.clock.hour, 11); assert.equal(scene.scenes[scene.activeSceneId].nodeId, 'b');
    assert.equal(scene.scenes[scene.activeSceneId].weather, ''); assert.equal(scene.scenes[scene.activeSceneId].participants, '');
    assert.equal(f.ctx.chatMetadata[historyKey].records['msg1:0'].nodeId, 'b'); assert.deepEqual(f.ctx.chatMetadata.unrelated, { kept: true });
    assert.equal(live.store.snapshot().maps.town.currentLocation, 'b'); assert.equal(live.draft.status().dirty, false);
    assert.equal(JSON.parse([...live.cache.values()][0]).synced, true);
    await assert.rejects(f.service.confirm(), /没有待确认/); assert.equal(f.saves, 1);
    live.dispose(); f.service.dispose();
});

test('failed save keeps fixed travel in memory and live map; retry persists without another advance', async () => {
    const f = setup(), live = mountRuntime(f); let calls = 0;
    f.ctx.saveMetadata = async () => { if (++calls === 1) throw Error('offline'); };
    f.service.stage(proposal()); await assert.rejects(f.service.confirm(), /保存失败/);
    assert.equal(f.service.dirty(), true); assert.equal(readCurrentScene(f.ctx).clock.hour, 11); assert.equal(live.store.snapshot().maps.town.currentLocation, 'b');
    assert.equal(JSON.parse([...live.cache.values()][0]).synced, false);
    assert.throws(() => live.store.applyUpdate([{ type: 'setCurrentLocation', nodeId: 'a' }]), /尚未保存/);
    await f.service.retrySave(); assert.equal(calls, 2); assert.equal(f.service.dirty(), false); assert.equal(readCurrentScene(f.ctx).clock.hour, 11);
    assert.equal(f.ctx.chatMetadata[KEY].events.length, 2); assert.equal(JSON.parse([...live.cache.values()][0]).synced, true);
    live.dispose(); f.service.dispose();
});

test('travel tokens reject source edits, chat switches and alternate candidates before any commit', async () => {
    for (const mutate of [f => { f.ctx.chat[0].swipe_id = 1; }, f => { f.ctx = { ...f.ctx, getCurrentChatId: () => 'other' }; }, f => { f.ctx.chatMetadata.dynamicMapV1.document.maps.town.edges[0].distance = 10; }]) {
        const f = setup(); f.service.stage(proposal()); mutate(f);
        await assert.rejects(f.service.confirm(), /变化/); assert.equal(f.saves, 0); assert.equal(readCurrentScene(f.ctx).clock.hour, 10); f.service.dispose();
    }
});

test('linked scene reuse preserves facts and multiple linked scenes require explicit choice', async () => {
    const f = setup(), state = f.ctx.chatMetadata[KEY].events[0].snapshot;
    const base = { id: 'station', name: '站台', participants: '售票员', weather: '晴', objects: '时钟', notes: '', mapId: 'town', nodeId: 'b', updatedAt: '', gameTime: null };
    state.scenes.station = base;
    assert.equal(f.service.stage(proposal()).summary.sceneId, 'station');
    state.scenes.second = { ...base, id: 'second', name: '候车室' };
    assert.throws(() => f.service.stage(proposal()), /多个场景/);
    f.service.stage(proposal({ sceneId: 'second' })); await f.service.confirm();
    assert.equal(readCurrentScene(f.ctx).activeSceneId, 'second'); assert.equal(readCurrentScene(f.ctx).scenes.second.objects, '时钟'); f.service.dispose();
});

test('travel warns about effects expiring at arrival without changing the effect record', async () => {
    const f = setup(), effects = emptyEffects(); effects.skills = [{ id: 'skill', name: '照明', reminder: '持续照明', book: '手动', entryId: 'skill' }];
    f.ctx.chatMetadata.amin_os_effects_v1 = changeEffect(effects, f.ctx.chat, 'create', { skillId: 'skill', targetMode: 'direct', holder: '玩家', scope: '光线', condition: '30 分钟', durationMinutes: 30 }, { clock });
    const before = structuredClone(f.ctx.chatMetadata.amin_os_effects_v1), preview = f.service.stage(proposal());
    assert.equal(preview.summary.dueEffects[0].name, '照明'); await f.service.confirm();
    assert.deepEqual(f.ctx.chatMetadata.amin_os_effects_v1, before); f.service.dispose();
});

test('map draft and ongoing map saves block travel until they are resolved', async () => {
    const f = setup(), live = mountRuntime(f);
    live.draft.mutate(doc => { doc.maps.town.name = '未保存名字'; }); assert.throws(() => f.service.stage(proposal()), /未保存/);
    live.draft.discard(); let resolve; f.ctx.saveMetadata = () => new Promise(done => { resolve = done; });
    live.store.applyUpdate([{ type: 'setView', view: { x: 10, y: 0, zoom: 1 } }]);
    assert.throws(() => f.service.stage(proposal()), /正在保存/); resolve(); await flush();
    assert.equal(f.service.stage(proposal()).summary.to, '车站'); live.dispose(); f.service.dispose();
});

test('external restore replaces live map and recovery cache while suppressing bridge saves and old move requests', async () => {
    const f = setup(), live = mountRuntime(f), bridge = createVariableBridge({ store: live.store, persistence: live.persistence, getContext: f.getContext, interval: 0, getLwb: () => ({ applyText() {} }) });
    await flush(); const ops = createOperationService(f.getContext), restored = structuredClone(f.ctx.chatMetadata.dynamicMapV1);
    restored.updatedAt = 2000; restored.document.maps.town.currentLocation = 'c';
    f.ctx.chatMetadata.variables = { 地图移动请求: JSON.stringify({ 请求ID: 'old', 地图版本: 2000, 地图ID: 'town', 地点ID: 'b' }) };
    ops.stage({ label: '恢复地图', patches: [{ path: ['dynamicMapV1'], value: restored }, { path: [historyKey], value: { sequence: ['msg1:0'], records: { 'msg1:0': { mapId: 'town', nodeId: 'c' } } } }] });
    await ops.confirm(); assert.equal(f.saves, 1); assert.equal(live.store.snapshot().maps.town.currentLocation, 'c');
    await bridge.sync(); assert.equal(f.saves, 1); assert.equal(live.store.snapshot().maps.town.currentLocation, 'c');
    live.persistence.switchChat(); assert.equal(live.store.snapshot().maps.town.currentLocation, 'c');
    ops.dispose(); bridge.destroy(); live.dispose(); f.service.dispose();
});

test('newer map versions and missing game clock remain intact after rejected travel', () => {
    const f = setup(); f.ctx.chatMetadata.dynamicMapV1.document.version = 99;
    const before = structuredClone(f.ctx.chatMetadata); assert.throws(() => f.service.stage(proposal()), /版本/); assert.deepEqual(f.ctx.chatMetadata, before);
    f.ctx.chatMetadata.dynamicMapV1.document.version = 1; f.ctx.chatMetadata[KEY].events[0].snapshot.clock = null;
    assert.throws(() => f.service.stage(proposal()), /设置游戏时间/); f.service.dispose();
});

test('fractional configured travel rounds upward and optional numeric override is previewed explicitly', () => {
    const f = setup(), map = f.ctx.chatMetadata.dynamicMapV1.document.maps.town;
    map.edges[0].distance = 0.1;
    assert.equal(f.service.stage(proposal()).summary.minutes, 2);
    const preview = f.service.stage(proposal({ minutes: '3' }));
    assert.equal(preview.summary.minutes, 3); assert.equal(preview.summary.timeSource, '用户填写');
    assert.equal(preview.summary.sceneAction, '创建并进入场景'); f.service.dispose();
});

test('ordinary map saves reserve the shared lease before another module can restore metadata', async () => {
    const f = setup(), live = mountRuntime(f); let resolveOld;
    f.ctx.saveMetadata = () => new Promise(resolve => { resolveOld = resolve; });
    live.store.applyUpdate([{ type: 'setView', view: { x: 5, y: 0, zoom: 1 } }]);
    const operations = createOperationService(f.getContext), restored = structuredClone(f.ctx.chatMetadata.dynamicMapV1);
    restored.updatedAt += 100; restored.document.maps.town.currentLocation = 'c';
    f.ctx.saveMetadata = async () => {};
    const proposal = { label: '恢复地图', patches: [{ path: ['dynamicMapV1'], value: restored }] };
    assert.throws(() => operations.stage(proposal), /正在保存/);
    assert.throws(() => live.store.applyUpdate([{ type: 'setCurrentLocation', nodeId: 'b' }]), /正在保存/);
    resolveOld(); await flush(); operations.stage(proposal); await operations.confirm();
    assert.equal(JSON.parse([...live.cache.values()][0]).document.maps.town.currentLocation, 'c');
    assert.equal(JSON.parse([...live.cache.values()][0]).synced, true);
    operations.dispose(); live.dispose(); f.service.dispose();
});

test('in-flight derived map variable saves block a travel commit instead of racing its persistence', async () => {
    const f = setup(), live = mountRuntime(f); let resolve, calls = 0;
    f.ctx.extensionSettings.dynamicMapIntegration.variables = true;
    f.ctx.saveMetadata = () => { calls++; return new Promise(done => { resolve = done; }); };
    const bridge = createVariableBridge({ store: live.store, persistence: live.persistence, getContext: f.getContext, interval: 0,
        loadVariables: async () => ({ setLocalVariable(key, value) { f.ctx.chatMetadata.variables ??= {}; f.ctx.chatMetadata.variables[key] = value; } }) });
    await flush(); assert.equal(calls, 1); assert.equal(f.service.busy(), true);
    assert.throws(() => f.service.stage(proposal()), /正在保存/);
    assert.equal(f.ctx.chatMetadata.dynamicMapV1.document.maps.town.currentLocation, 'a');
    resolve(); await flush(); f.ctx.saveMetadata = async () => { calls++; };
    f.service.stage(proposal()); await f.service.confirm(); assert.equal(calls, 2);
    assert.equal(readCurrentScene(f.ctx).clock.hour, 11); bridge.destroy(); live.dispose(); f.service.dispose();
});

test('removing a restored map clears live/cache state and clean empty chats can accept imported maps', async () => {
    const f = setup(), live = mountRuntime(f), ops = createOperationService(f.getContext);
    ops.stage({ label: '恢复无地图状态', patches: [{ path: ['dynamicMapV1'], remove: true }] }); await ops.confirm();
    assert.equal(f.ctx.chatMetadata.dynamicMapV1, undefined); assert.equal([...live.cache.values()][0], 'null');
    assert.equal(live.store.snapshot().maps.town, undefined); assert.equal(f.saves, 1);
    assert.doesNotThrow(() => assertMapReady(f.ctx, { allowEmpty: true }));
    assert.throws(() => assertMapReady(f.ctx), /地图显示/);
    live.draft.mutate(document => { document.maps[document.activeMap].name = '未保存地图草稿'; });
    assert.throws(() => assertMapReady(f.ctx, { allowEmpty: true }), /未保存/);
    ops.dispose(); live.dispose(); f.service.dispose();
});

test('pending preview disappears after switching chat or changing its source map', () => {
    const f = setup(); f.service.stage(proposal());
    f.ctx.chat[0].swipe_id = 1; assert.equal(f.service.preview(), null);
    f.ctx.chat[0].swipe_id = 0; f.service.stage(proposal());
    f.ctx.chatMetadata.dynamicMapV1.document.maps.town.edges[0].distance = 9;
    assert.equal(f.service.preview(), null); assert.equal(f.saves, 0); f.service.dispose();
});
