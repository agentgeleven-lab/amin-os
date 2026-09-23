import * as Characters from '../characters/model.js';
import * as Inventory from '../inventory/model.js';
import * as Relationships from '../relationships/model.js';
import * as Scene from '../scene/model.js';
import * as Journal from '../journal/model.js';
import * as Effects from '../effects/model.js';
import * as Information from '../information/model.js';
import { validateDocument } from '../map/src/core/protocol.js';
import { materialize, validateModules, MODULE_LABELS } from '../saves/adapters.js';
import { KEY as LINKAGE_KEY, readLinkageSettings, readLinkageState, validateLinkageState } from '../linkage/policy.js';
import { buildReferenceIndex } from '../linkage/references.js';
import { chatIdentity, chatPath } from '../shared/operations.js';
import { checkpointState } from '../status/state-checkpoint.js';

export const MIGRATION_KEY = 'amin_os_state2_v1';
export const BACKUP_KEY = 'amin_os_state2_backup_v1';
export const MIGRATION_OWNER = 'amin-os/state2-v1';
export const OWNERSHIP_FLOOR = '-1';
export const ROOTS = Object.freeze({
    characters: 'AminOS人物', inventory: 'AminOS背包', relationships: 'AminOS关系',
    scene: 'AminOS场景', journal: 'AminOS剧情', effects: 'AminOS效果',
    map: 'AminOS地图', information: 'AminOS信息', dice: 'AminOS骰子',
});
export const OWNED_VARIABLE_ROOTS = Object.freeze(Object.values(ROOTS));
export const NATIVE_VARIABLE_ROOTS = Object.freeze({ status: '状态栏', organizations: '势力资料' });
export const DICE_RULE_PATHS = Object.freeze([ROOTS.dice, `${ROOTS.dice}.rolls`, `${ROOTS.dice}.rolls.[*]`, `${ROOTS.dice}.rolls.[*].*`,
    `${ROOTS.dice}.rolls.[*].settings.*`, `${ROOTS.dice}.rolls.[*].results`, `${ROOTS.dice}.rolls.[*].results.[*]`,
    `${ROOTS.dice}.rolls.[*].results.[*].*`, `${ROOTS.dice}.rolls.[*].sent.*`, `${ROOTS.dice}.rolls.[*].pending.*`]);
export const STATE2_OPERATION_PATHS = Object.freeze([
    [MIGRATION_KEY], [BACKUP_KEY], [LINKAGE_KEY],
    ...OWNED_VARIABLE_ROOTS.map(root => ['variables', root]),
    ...DICE_RULE_PATHS.map(path => ['LWB_RULES_V2', path]),
    ['extensions', 'LittleWhiteBox', 'stateLogV2'],
    ['extensions', 'LittleWhiteBox', 'stateCkptV2'],
]);

const META = Object.freeze({
    characters: Characters.KEY, inventory: Inventory.KEY, relationships: Relationships.KEY,
    scene: Scene.KEY, journal: Journal.KEY, effects: Effects.KEY,
    map: 'dynamicMapV1', information: Information.KEY, dice: 'amin_os_dice_v1',
});
const ORDER = Object.freeze(['characters', 'inventory', 'relationships', 'map', 'scene', 'effects', 'journal', 'information', 'dice']);
const BACKUP_ROOTS = Object.freeze([...Object.values(META), LINKAGE_KEY, 'dynamicMapPositionHistoryV1']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePart = part => typeof part === 'string' && !!part && !['__proto__', 'prototype', 'constructor'].includes(part);

function currentFloor(ctx) { return (ctx.chat?.length ?? 0) - 1; }
function ensureContext(ctx) {
    if (!plain(ctx?.chatMetadata) || !plain(ctx.chatMetadata.variables ?? {})) throw Error('当前聊天变量或元数据不可读取。');
    if ((ctx.getCurrentChatId?.() ?? ctx.chatId) == null) throw Error('请先打开一个聊天。');
}
function assertInternals(ctx) {
    const lwb = ctx.chatMetadata.extensions?.LittleWhiteBox;
    const log = lwb?.stateLogV2, ckpt = lwb?.stateCkptV2;
    if (log !== undefined && (!plain(log) || log.version !== 1 || !plain(log.floors))) throw Error('小白X变量 2.0 日志版本或格式不兼容，原资料未改写。');
    if (ckpt !== undefined && (!plain(ckpt) || ckpt.version !== 1 || !plain(ckpt.points))) throw Error('小白X变量 2.0 检查点版本或格式不兼容，原资料未改写。');
    return { log, ckpt };
}
function validMarker(ctx) {
    const marker = ctx.chatMetadata[MIGRATION_KEY];
    if (marker === undefined) return null;
    if (!plain(marker) || marker.version !== 1 || marker.owner !== MIGRATION_OWNER || !Array.isArray(marker.roots)
        || !same([...marker.roots].sort(), [...OWNED_VARIABLE_ROOTS].sort()) || typeof marker.createdAt !== 'string') {
        throw Error('Amin OS 变量迁移标记不兼容，原资料未改写。');
    }
    const backup = ctx.chatMetadata[BACKUP_KEY];
    if (!plain(backup) || backup.version !== 1 || !plain(backup.roots) || !plain(backup.source)) {
        throw Error('Amin OS 变量迁移备份缺失或不兼容，原资料未改写。');
    }
    return marker;
}

export function nativeState2Status(ctx) {
    if (!ctx?.chatMetadata) return { enabled: false, migrated: false, owned: false };
    ensureContext(ctx);
    const { log } = assertInternals(ctx), marker = validMarker(ctx);
    const ownership = log?.floors?.[OWNERSHIP_FLOOR];
    return {
        enabled: ctx.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0',
        migrated: !!marker,
        owned: !!marker && ownership?.signature === MIGRATION_OWNER && Array.isArray(ownership.roots)
            && OWNED_VARIABLE_ROOTS.every(root => ownership.roots.includes(root)),
    };
}

function emptySnapshot(module, current = null) {
    switch (module) {
        case 'characters': return Characters.emptyState();
        case 'inventory': return Inventory.emptyState();
        case 'relationships': return { ...Relationships.emptyState(), ...Object.fromEntries(['settings','thresholdRules','thresholdAlerts'].filter(key => current?.[key] !== undefined).map(key => [key, clone(current[key])])) };
        case 'scene': return { ...Scene.emptyState(), ...Object.fromEntries(['periods','timeRules','absenceRules','settings'].filter(key => current?.[key] !== undefined).map(key => [key, clone(current[key])])) };
        case 'journal': return { version: 1, limit: current?.limit ?? 40000, entries: [], ...(current?.autoChronicle ? { autoChronicle: clone(current.autoChronicle) } : {}), drafts: [] };
        case 'effects': return { version: 1, enabled: current?.enabled ?? true, limit: current?.limit ?? 30000, effects: [], consumedActionIds: [] };
        case 'information': return { version: 1, enabled: current?.enabled ?? true, limit: current?.limit ?? 40000, records: [] };
        case 'dice': return { version: 1, rolls: [] };
        case 'map': return null; // The map protocol has no valid zero-map document.
        default: throw Error('未知 Amin OS 变量模块。');
    }
}
function storySnapshot(module, snapshot) {
    if (!snapshot) return null;
    switch (module) {
        case 'relationships': return { relationships: snapshot.relationships };
        case 'scene': return { clock: snapshot.clock, scenes: snapshot.scenes, activeSceneId: snapshot.activeSceneId, schedules: snapshot.schedules };
        case 'journal': return { entries: snapshot.entries, drafts: snapshot.drafts ?? [] };
        case 'effects': return { effects: snapshot.effects, consumedActionIds: snapshot.consumedActionIds ?? [] };
        case 'information': return { records: snapshot.records };
        default: return snapshot;
    }
}
function wireSnapshot(module, snapshot) {
    if (snapshot === null) return null;
    if (!['relationships','scene','journal','effects','information'].includes(module)) return clone(snapshot);
    return { version: 1, ...clone(storySnapshot(module, snapshot)) };
}
function withLocalSettings(module, canonical, current) {
    if (canonical === null) return emptySnapshot(module, current);
    const value = clone(canonical);
    if (module === 'relationships') for (const key of ['settings','thresholdRules','thresholdAlerts']) {
        if (current?.[key] !== undefined) value[key] = clone(current[key]);
        else if (key === 'settings') value[key] = clone(Relationships.emptyState().settings);
        else delete value[key];
    }
    if (module === 'scene') for (const key of ['periods','timeRules','absenceRules','settings']) value[key] = clone(current?.[key] ?? Scene.emptyState()[key]);
    if (module === 'journal') {
        value.limit = current?.limit ?? 40000;
        if (current?.autoChronicle) value.autoChronicle = clone(current.autoChronicle);
        else delete value.autoChronicle;
    }
    if (module === 'effects') { value.enabled = current?.enabled ?? true; value.limit = current?.limit ?? 30000; }
    if (module === 'information') { value.enabled = current?.enabled ?? true; value.limit = current?.limit ?? 40000; }
    return value;
}
function validateSnapshot(module, value) {
    if (value === null && module === 'map') return null;
    const all = Object.fromEntries(Object.keys(MODULE_LABELS).map(key => [key, null]));
    all[module] = value;
    validateModules(all);
    return clone(value);
}
function canonicalSnapshots(ctx, current = materialize(ctx)) {
    const output = {};
    for (const [module, root] of Object.entries(ROOTS)) {
        const raw = ctx.chatMetadata.variables?.[root];
        if (raw === undefined || raw === '') output[module] = emptySnapshot(module, current[module]);
        else {
            if (typeof raw !== 'string') throw Error(`${root} 不是 JSON 字符串，原资料未改写。`);
            let parsed;
            try { parsed = JSON.parse(raw); } catch { throw Error(`${root} 不是有效 JSON，原资料未改写。`); }
            if (parsed === null && module !== 'map') throw Error(`${root} 不能是 null，原资料未改写。`);
            output[module] = validateSnapshot(module, withLocalSettings(module, parsed, current[module]));
        }
    }
    return output;
}
function atPath(object, path) {
    let value = object;
    for (const key of path) { if (!plain(value) || !own(value, key)) return { exists: false }; value = value[key]; }
    return { exists: true, value };
}
function applyPatch(object, patch) {
    const path = patch.path;
    if (!Array.isArray(path) || !path.length || path.some(part => !safePart(part))) throw Error('状态同步包含无效资料路径。');
    let parent = object;
    for (const part of path.slice(0, -1)) {
        if (!own(parent, part)) parent[part] = {};
        if (!plain(parent[part])) throw Error('状态同步的资料上级不是对象。');
        parent = parent[part];
    }
    if (patch.remove === true) delete parent[path.at(-1)];
    else parent[path.at(-1)] = clone(patch.value);
}
function diffPath(before, after, path) {
    const a = atPath(before, path), b = atPath(after, path);
    if (same(a, b)) return null;
    return b.exists ? { path, value: clone(b.value) } : { path, remove: true };
}
function shadowOf(ctx) { return { ...ctx, chatMetadata: clone(ctx.chatMetadata), saveMetadataDebounced() {} }; }
function ownerLogPatch(ctx) {
    const { log } = assertInternals(ctx);
    const previous = log?.floors?.[OWNERSHIP_FLOOR];
    if (previous !== undefined && (previous.signature !== MIGRATION_OWNER || !Array.isArray(previous.roots)
        || !Array.isArray(previous.ops) || previous.ops.length || !Array.isArray(previous.rules) || previous.rules.length)) {
        throw Error('小白X负楼层日志已被其他内容占用，Amin OS 不会覆盖。');
    }
    const nativePresent = Object.values(NATIVE_VARIABLE_ROOTS).filter(root => own(ctx.chatMetadata.variables, root));
    const roots = [...new Set([...(previous?.roots ?? []), ...OWNED_VARIABLE_ROOTS, ...nativePresent])].sort();
    if (previous && same([...previous.roots].sort(), roots)) return null;
    const next = clone(log ?? { version: 1, floors: {} });
    next.floors[OWNERSHIP_FLOOR] = { signature: MIGRATION_OWNER, rules: [], ops: [], roots, ts: Date.now() };
    return { path: ['extensions','LittleWhiteBox','stateLogV2'], value: next };
}
function diceRulePatches(ctx) {
    const existing = ctx.chatMetadata.LWB_RULES_V2 ?? {};
    if (!plain(existing)) throw Error('小白X变量规则格式不兼容，原资料未改写。');
    return DICE_RULE_PATHS.flatMap(path => {
        const next = { ...(plain(existing[path]) ? existing[path] : {}), ro: true };
        return same(existing[path], next) ? [] : [{ path: ['LWB_RULES_V2', path], value: next }];
    });
}
function checkpointPatch(ctx) {
    const copy = shadowOf(ctx);
    if (!checkpointState(copy)) return null;
    return { path: ['extensions','LittleWhiteBox','stateCkptV2'], value: copy.chatMetadata.extensions.LittleWhiteBox.stateCkptV2 };
}

/** One-time, reversible import. The old stores remain in place and in BACKUP_KEY. */
export function migrateState2(ctx) {
    ensureContext(ctx);
    const status = nativeState2Status(ctx);
    if (status.migrated || !status.enabled) return { patches: [], migrated: status.migrated, changed: false };
    if (currentFloor(ctx) < 0) return { patches: [], migrated: false, changed: false, reason: '请先在当前聊天发送一条消息，再迁移到小白X变量 2.0。' };
    for (const root of OWNED_VARIABLE_ROOTS) if (own(ctx.chatMetadata.variables, root)) throw Error(`聊天变量「${root}」已存在，迁移不会覆盖它。`);
    const current = materialize(ctx), now = new Date().toISOString(), original = ctx.chatMetadata;
    const backup = { version: 1, source: { identity: chatIdentity(ctx), floor: currentFloor(ctx), path: chatPath(ctx.chat) }, createdAt: now,
        roots: Object.fromEntries(BACKUP_ROOTS.filter(key => own(original, key)).map(key => [key, clone(original[key])])),
        nativeVariables: Object.fromEntries(Object.values(NATIVE_VARIABLE_ROOTS).filter(root => own(original.variables, root)).map(root => [root, clone(original.variables[root])])) };
    const marker = { version: 1, owner: MIGRATION_OWNER, sourceIdentity: backup.source.identity, sourceFloor: backup.source.floor,
        createdAt: now, roots: [...OWNED_VARIABLE_ROOTS] };
    const shadow = shadowOf(ctx), wanted = [];
    wanted.push({ path: [BACKUP_KEY], value: backup }, { path: [MIGRATION_KEY], value: marker });
    const oldPolicy = readLinkageState(ctx), flags = readLinkageSettings(ctx).modules;
    wanted.push({ path: [LINKAGE_KEY], value: validateLinkageState({ ...oldPolicy, modules: flags }) });
    for (const [module, root] of Object.entries(ROOTS)) {
        const snapshot = current[module] ?? emptySnapshot(module);
        if (snapshot !== null) wanted.push({ path: ['variables', root], value: JSON.stringify(wireSnapshot(module, validateSnapshot(module, snapshot))) });
    }
    wanted.push(ownerLogPatch(ctx), ...diceRulePatches(ctx));
    const included = wanted.filter(Boolean);
    for (const patch of included) applyPatch(shadow.chatMetadata, patch);
    const ckpt = checkpointPatch(shadow);
    if (!ckpt) throw Error('未能为当前楼层建立小白X变量 2.0 检查点，迁移已取消。');
    included.push(ckpt);
    applyPatch(shadow.chatMetadata, ckpt);
    return { patches: included.filter(patch => diffPath(original, shadow.chatMetadata, patch.path)),
        migrated: true, changed: true, backup, marker };
}

function generatedId(ctx, module, label) {
    const raw = JSON.stringify([module, label, chatIdentity(ctx), chatPath(ctx.chat), ctx.chatMetadata[META[module]]]);
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
    const prefix = `s2_${module}_${(hash >>> 0).toString(36)}`;
    let index = 0;
    return () => `${prefix}_${index++}`;
}
function restoreOne(ctx, module, target, at) {
    const id = generatedId(ctx, module, JSON.stringify(storySnapshot(module, target))), makeId = id;
    if (module === 'characters') return [{ path: [Characters.KEY], value: Characters.buildRestore(ctx, target, { id: id(), at, reason: '小白X变量 2.0 当前楼层同步' }) }];
    if (module === 'inventory') return [{ path: [Inventory.KEY], value: Inventory.buildRestoreStore(ctx, target, { id: id(), at, reason: '小白X变量 2.0 当前楼层同步' }) }];
    if (module === 'relationships') return [{ path: [Relationships.KEY], value: Relationships.buildRestore(ctx, target, { id: id(), at }) }];
    if (module === 'scene') {
        const value = Scene.appendEvent(Scene.readStore(ctx), ctx.chat,
            { op: 'restore', reason: '小白X变量 2.0 当前楼层同步', state: target,
                details: { beforeTime: Scene.readCurrentScene(ctx).clock, afterTime: target.clock } }, { eventId: id(), at });
        return [{ path: [Scene.KEY], value }];
    }
    if (module === 'journal') return [{ path: [Journal.KEY], value: Journal.restoreJournal(ctx, target, { at, makeId, warnings: [] }) }];
    if (module === 'effects') return [{ path: [Effects.KEY], value: Effects.restoreEffects(ctx.chatMetadata[Effects.KEY] ?? Effects.empty(), ctx.chat, target, { operationId: id(), at }) }];
    if (module === 'information') {
        const before = Information.read(ctx), next = clone(before), path = Information.path(ctx.chat);
        for (const record of Information.current(before, ctx.chat)) next.history.push({ id: id(), recordId: record.id, path, at, reason: '小白X变量 2.0 当前楼层同步', action: 'reset', snapshot: null });
        for (const record of target.records) next.history.push({ id: id(), recordId: record.id, path, at, reason: '小白X变量 2.0 当前楼层同步', snapshot: Information.validateRecord(record) });
        return [{ path: [Information.KEY], value: next }];
    }
    if (module === 'map') {
        if (target === null) return own(ctx.chatMetadata, META.map) ? [{ path: [META.map], remove: true }] : [];
        const old = ctx.chatMetadata[META.map], updatedAt = Math.max(Date.parse(at), (old?.updatedAt ?? 0) + 1);
        return [{ path: [META.map], value: { updatedAt, document: validateDocument(target) } }];
    }
    if (module === 'dice') return [{ path: [META.dice], value: clone(target) }];
    throw Error('未知 Amin OS 变量模块。');
}
function assertNativeUpdateScope(ctx) {
    const floor = currentFloor(ctx), log = ctx.chatMetadata.extensions?.LittleWhiteBox?.stateLogV2?.floors;
    const ops = log?.[String(floor)]?.ops ?? [];
    if (!Array.isArray(ops)) throw Error('小白X当前楼层日志格式无效。');
    const denied = [
        [ROOTS.relationships, ['settings']], [ROOTS.scene, ['settings','periods','timeRules','absenceRules']],
        [ROOTS.journal, ['limit','autoChronicle']], [ROOTS.effects, ['enabled','limit']],
        [ROOTS.information, ['enabled','limit']],
    ];
    for (const op of ops) {
        const path = String(op?.path ?? '');
        if (path === ROOTS.dice || path.startsWith(ROOTS.dice + '.')) throw Error('骰子结果只能由骰子应用产生，小白X输出不得改写。');
        for (const [root, fields] of denied) {
            if (path === root || fields.some(field => path === `${root}.${field}` || path.startsWith(`${root}.${field}.`))) {
                throw Error(`小白X输出试图修改 ${root} 的用户设置，未同步到应用。`);
            }
        }
    }
}

/** Project canonical LWB variables into legacy event stores, one changed module at a time. */
export function projectState2(ctx) {
    ensureContext(ctx);
    const status = nativeState2Status(ctx);
    if (!status.migrated || !status.enabled) return { patches: [], changed: [] };
    assertNativeUpdateScope(ctx);
    const current = materialize(ctx), canonical = canonicalSnapshots(ctx, current), shadow = shadowOf(ctx), patches = [], changed = [];
    const at = new Date().toISOString();
    for (const module of ORDER) {
        const latest = materialize(shadow)[module] ?? emptySnapshot(module, current[module]);
        const desired = withLocalSettings(module, canonical[module], latest);
        if (same(storySnapshot(module, latest), storySnapshot(module, desired))) continue;
        const generated = restoreOne(shadow, module, desired, at);
        for (const patch of generated) { applyPatch(shadow.chatMetadata, patch); patches.push(patch); }
        changed.push(module);
    }
    // Existing broken references are retained; a new missing reference is rejected.
    const beforeIndex = buildReferenceIndex(current), afterIndex = buildReferenceIndex(materialize(shadow));
    const prior = new Set(beforeIndex.unresolved.map(ref => JSON.stringify([ref.from, ref.to])));
    const introduced = afterIndex.unresolved.filter(ref => !prior.has(JSON.stringify([ref.from, ref.to])));
    if (introduced.length) throw Error('小白X变量包含新的无效跨应用引用：' + introduced.map(ref => `${ref.from} → ${ref.to}`).join('；'));
    return { patches, changed };
}

function touchedModule(path) {
    if (!Array.isArray(path) || !path.length) return null;
    if (path[0] === 'variables') return Object.entries(NATIVE_VARIABLE_ROOTS).find(([, root]) => root === path[1])?.[0] ?? Object.entries(ROOTS).find(([, root]) => root === path[1])?.[0] ?? null;
    return Object.entries(META).find(([, root]) => root === path[0])?.[0] ?? null;
}
function asPatch(ctx, item) {
    if (!Array.isArray(item)) return item;
    const value = atPath(ctx.chatMetadata, item);
    return value.exists ? { path: item, value: value.value } : { path: item, remove: true };
}

/** Extra patches only. The caller keeps its own original patches in the same transaction. */
export function manualState2Patches(ctx, input = []) {
    ensureContext(ctx);
    if (!Array.isArray(input)) throw Error('手动变量同步需要资料路径列表。');
    const original = input.map(item => asPatch(ctx, item)), touched = [...new Set(original.map(patch => touchedModule(patch.path)).filter(Boolean))];
    if (!touched.length) return { patches: [], changed: [] };
    const status = nativeState2Status(ctx);
    if (!status.migrated) return { patches: [], changed: [], reason: '当前聊天尚未迁移至小白X变量 2.0。' };
    if (!status.enabled) throw Error('当前聊天已迁移，请先启用小白X变量 2.0，再修改关联应用资料。');
    const pending = projectState2(ctx).changed.filter(module => !touched.includes(module));
    if (pending.length) throw Error('小白X变量还有未同步的应用资料，请先刷新后重试：' + pending.join('、'));
    const shadow = shadowOf(ctx), candidate = [];
    for (const patch of original) applyPatch(shadow.chatMetadata, patch);
    const state = materialize(shadow);
    for (const module of touched) {
        const root = ROOTS[module];
        if (!root) continue; // Native status/organization roots already occur in the caller's patch.
        const value = state[module] ?? emptySnapshot(module);
        candidate.push(value === null ? { path: ['variables', root], remove: true }
            : { path: ['variables', root], value: JSON.stringify(wireSnapshot(module, validateSnapshot(module, value))) });
    }
    for (const patch of candidate) applyPatch(shadow.chatMetadata, patch);
    const ownership = ownerLogPatch(shadow), diceRules = diceRulePatches(shadow);
    for (const patch of [ownership, ...diceRules].filter(Boolean)) applyPatch(shadow.chatMetadata, patch);
    const checkpoint = checkpointPatch(shadow);
    const extra = [...candidate, ...[ownership, ...diceRules].filter(Boolean)];
    if (checkpoint) { extra.push(checkpoint); applyPatch(shadow.chatMetadata, checkpoint); }
    const originalPaths = new Set(original.map(patch => JSON.stringify(patch.path)));
    return { patches: extra.filter(patch => !originalPaths.has(JSON.stringify(patch.path)) && diffPath(ctx.chatMetadata, shadow.chatMetadata, patch.path)),
        changed: touched, migrated: true };
}

/** Legacy writers call after their metadata mutation and before their one save. */
export function prepareState2ManualWrite(ctx, paths) {
    const result = manualState2Patches(ctx, paths);
    if (!result.patches.length) return () => {};
    const applied = [], metadata = ctx.chatMetadata;
    function rollback() {
        for (let i = applied.length - 1; i >= 0; i--) {
            const { before, patch } = applied[i], current = atPath(metadata, patch.path);
            const expected = patch.remove ? { exists: false } : { exists: true, value: patch.value };
            if (!same(current, expected)) continue;
            applyPatch(metadata, before.exists ? { path: patch.path, value: before.value } : { path: patch.path, remove: true });
        }
        applied.length = 0;
    }
    try {
        for (const patch of result.patches) { const before = atPath(metadata, patch.path); applyPatch(metadata, patch); applied.push({ before: clone(before), patch }); }
    } catch (error) { rollback(); throw error; }
    return rollback;
}
