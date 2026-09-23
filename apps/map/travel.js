import { uuid } from '../../uuid.js';
import { createOperationService } from '../shared/operations.js';
import { KEY as SCENE_KEY, readStore, readCurrentScene, transition, appendEvent } from '../scene/model.js';
import { contextExpiryPreview } from '../effects/model.js';
import { validateDocument } from './src/core/protocol.js';
import { assertMapReady } from './src/integrations/runtime.js';

const MAP_KEY = 'dynamicMapV1', HISTORY_KEY = 'dynamicMapPositionHistoryV1';
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const paths = () => [[MAP_KEY], [SCENE_KEY], [HISTORY_KEY], ['amin_os_effects_v1']];

export function readTravelMap(ctx) {
    const raw = ctx?.chatMetadata?.[MAP_KEY];
    if (!object(raw) || !object(raw.document) || !Number.isFinite(raw.updatedAt)) throw Error('请先在地图应用保存当前聊天地图。');
    return { ...clone(raw), document: validateDocument(clone(raw.document)) };
}

function passage(item) {
    const data = item?.metadata ?? {};
    for (const key of ['passable', 'blocked']) if (data[key] !== undefined && typeof data[key] !== 'boolean') throw Error('地图通行标记格式无效，请先检查地图。');
    return data.passable !== false && data.blocked !== true;
}
function minutesFor(map, edge, method) {
    const distance = edge.distance === undefined ? map.metadata.rules?.segmentDistance : edge.distance;
    if (!Number.isFinite(distance) || distance < 0 || !method || !Number.isFinite(method.speed) || method.speed <= 0) return null;
    const value = distance / method.speed * 60;
    return Number.isFinite(value) && value <= 5256000 ? Math.ceil(value) : null;
}
function methodsFor(map) {
    const methods = map.metadata.rules?.methods ?? [];
    // Missing legacy rules do not invent a distance or walking speed.
    return methods.map(method => ({ id: method.id, name: method.name, speed: method.speed }));
}
export function travelDestinations(ctx, methodId) {
    const envelope = readTravelMap(ctx), doc = envelope.document, map = doc.maps[doc.activeMap], origin = map.nodes[map.currentLocation];
    const scene = readCurrentScene(ctx), methods = methodsFor(map), selected = methodId ? methods.find(method => method.id === methodId) : methods[0];
    if (methodId && !selected) throw Error('通行方式已不存在，请重新选择。');
    const routes = origin?.discovered ? map.edges.filter(edge => edge.discovered && (edge.from === origin.id || edge.to === origin.id)).flatMap(edge => {
        const node = map.nodes[edge.from === origin.id ? edge.to : edge.from];
        if (!node?.discovered) return [];
        const directional = edge.from === origin.id || edge.bidirectional;
        const passable = passage(origin) && passage(node) && passage(edge);
        const reason = !directional ? '单向道路不能从当前方向出发' : !passable ? '道路或地点已标记不可通行' : '';
        return [{ edgeId: edge.id, nodeId: node.id, name: node.name, description: node.description, routeName: edge.name || '未命名道路',
            minutes: minutesFor(map, edge, selected), accessible: directional && passable, reason,
            methods: methods.map(method => ({ ...method, minutes: minutesFor(map, edge, method), accessible: directional && passable, reason })),
            scenes: Object.values(scene.scenes).filter(value => value.mapId === map.id && value.nodeId === node.id).map(value => ({ id: value.id, name: value.name })),
        }];
    }) : [];
    return { mapId: map.id, mapName: map.name, fromNodeId: origin?.id ?? null, fromName: origin?.name ?? '', methods, methodId: selected?.id ?? null, routes, clock: clone(scene.clock) };
}

function positionPatch(ctx, mapId, nodeId) {
    const raw = ctx.chatMetadata[HISTORY_KEY];
    if (raw === undefined) return null;
    if (!object(raw) || !object(raw.records) || (raw.sequence !== undefined && !Array.isArray(raw.sequence))) throw Error('地图位置历史格式无效，原记录未修改。');
    const sequence = (ctx.chat ?? []).map(message => message.extra?.dynamic_map_message_id ? `${message.extra.dynamic_map_message_id}:${message.swipe_id ?? 0}` : null);
    if (!sequence.length || sequence.some(value => value === null)) return null;
    const value = clone(raw); value.sequence = sequence; value.records[sequence.at(-1)] = { mapId, nodeId };
    return { path: [HISTORY_KEY], value };
}

export function createTravelService(getContext = () => globalThis.SillyTavern?.getContext?.(), { createId = uuid, now = Date.now, assertReady = assertMapReady } = {}) {
    const operations = createOperationService(getContext);
    let pendingToken = null;
    const capture = () => operations.capture(paths());
    const check = token => { const ctx = operations.check(token); assertReady(ctx); return ctx; };
    function stage(data, token = capture()) {
        const ctx = check(token), envelope = readTravelMap(ctx), options = travelDestinations(ctx, data?.methodId);
        if (!options.fromNodeId) throw Error('请先在地图中明确保存当前位置。');
        if (!options.clock) throw Error('请先在场景与时间中设置游戏时间，再预览旅行。');
        const matches = options.routes.filter(route => route.nodeId === data?.nodeId && (!data.edgeId || route.edgeId === data.edgeId));
        if (matches.length !== 1) throw Error(matches.length ? '有多条道路通往该地点，请明确选择道路。' : '目标不在当前已发现的相邻道路上。');
        const route = matches[0]; if (!route.accessible) throw Error(route.reason);
        const supplied = typeof data.minutes === 'string' ? data.minutes.trim() : data.minutes;
        const explicit = supplied !== undefined && supplied !== null && supplied !== '';
        if (explicit && typeof supplied !== 'number' && (typeof supplied !== 'string' || !/^\d+$/.test(supplied))) throw Error('旅行耗时需为 0–5256000 的整数分钟。');
        const minutes = explicit ? Number(supplied) : route.minutes;
        if (minutes === null) throw Error('这条道路的耗时未知，请明确填写本次旅行分钟数。');
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 5256000) throw Error('旅行耗时需为 0–5256000 的整数分钟。');
        const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
        if (!reason || reason.length > 400) throw Error('请填写 1–400 字的旅行确认原因。');
        const stamp = now(), at = new Date(stamp).toISOString(), initial = readCurrentScene(ctx);
        let state = minutes ? transition(initial, 'advance-time', { minutes, reason }).state : clone(initial);
        let sceneId = data.sceneId || (route.scenes.length === 1 ? route.scenes[0].id : null);
        if (!sceneId && route.scenes.length > 1) throw Error('目的地关联多个场景，请明确选择要进入的场景。');
        if (sceneId && !route.scenes.some(scene => scene.id === sceneId)) throw Error('所选场景未关联到目的地，或已不在当前分支。');
        if (sceneId) state = transition(state, 'switch-scene', { sceneId, reason }, { at }).state;
        else {
            sceneId = createId();
            state = transition(state, 'save-scene', { scene: { name: route.name.slice(0, 120), mapId: options.mapId, nodeId: route.nodeId }, activate: true, reason }, { sceneId, at }).state;
        }
        const method = options.methods.find(value => value.id === options.methodId);
        const summary = { from: options.fromName, to: route.name, mapId: options.mapId, fromNodeId: options.fromNodeId, nodeId: route.nodeId,
            edgeId: route.edgeId, routeName: route.routeName, methodName: method?.name ?? '手动指定耗时', methodId: method?.id ?? null,
            minutes, timeSource: explicit ? '用户填写' : '道路距离与速度计算，向上取整到分钟', beforeTime: clone(initial.clock), afterTime: clone(state.clock),
            sceneId, sceneName: state.scenes[sceneId].name, sceneAction: route.scenes.some(scene => scene.id === sceneId) ? '进入已保存场景' : '创建并进入场景', dueEffects: contextExpiryPreview(ctx, state.clock).newlyExpired };
        const sceneStore = appendEvent(readStore(ctx), ctx.chat, { op: 'travel', state, reason, details: { ...summary } }, { eventId: createId(), at });
        const document = clone(envelope.document); document.maps[options.mapId].currentLocation = route.nodeId;
        const nextMap = { ...envelope, updatedAt: Math.max(stamp, envelope.updatedAt + 1), document: validateDocument(document) };
        const patches = [{ path: [MAP_KEY], value: nextMap }, { path: [SCENE_KEY], value: sceneStore }];
        const history = positionPatch(ctx, options.mapId, route.nodeId); if (history) patches.push(history);
        pendingToken = token;
        return operations.stage({ label: '确认旅行', patches, summary }, token);
    }
    function preview() {
        const value = operations.preview(); if (!value) return null;
        try { operations.check(pendingToken); }
        catch { pendingToken = null; operations.discard(); return null; }
        return value;
    }
    return { context: getContext, capture, check, stage, destinations: methodId => travelDestinations(getContext(), methodId),
        preview, confirm() { assertReady(getContext()); return operations.confirm(); }, retrySave: operations.retrySave,
        discard: operations.discard, status: operations.status, busy: operations.busy, dirty: operations.dirty, subscribe: operations.subscribe, dispose: operations.dispose };
}
let shared;
export function getSharedTravelService(getContext) { return shared ??= createTravelService(getContext); }
