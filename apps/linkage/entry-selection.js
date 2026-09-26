import { buildReferenceIndex } from './references.js';

const collections = { characters: ['characters'], inventory: ['items', 'balances', 'ledger'], relationships: ['relationships'],
    scene: ['schedules'], journal: ['entries'], effects: ['effects'], information: ['records'], dice: ['rolls'] };
const list = value => Array.isArray(value) ? value : [];

/** Receives privacy-projected readable data only. Never reads raw/native variables. */
export function selectContextEntries(data, { enabled = false, pinned = [] } = {}, required = new Map(), manualLinks = []) {
    const index = buildReferenceIndex(data, manualLinks), catalog = new Map(index.entities.map(entry => [entry.id, entry]));
    // Ledger rows have their own identities, but are not normal reference targets.
    for (const row of list(data.inventory?.ledger)) if (row.id) catalog.set(`inventory:${row.id}`, { id: `inventory:${row.id}`, module: 'inventory', label: row.summary || row.id });
    const chosen = new Map(), pinnedSet = new Set(pinned.filter(id => catalog.has(id)));
    const pinDependencies = new Set(pinnedSet);
    // Three bounded outgoing steps cover relation -> person -> stat -> status.
    // Never traverse inverse edges transitively through the social network.
    for (let depth = 0; depth < 3; depth++) {
        const previous = new Set(pinDependencies);
        for (const link of index.links) if (previous.has(link.from) && catalog.has(link.to)) pinDependencies.add(link.to);
    }
    for (const id of pinnedSet) chosen.set(id, '用户固定保留');
    const active = data.scene?.activeSceneId, sceneKey = active && `scene:${active}`;
    if (catalog.has(sceneKey)) chosen.set(sceneKey, '当前实际场景');
    // Actual presence is explicit scene data. Schedules and matching names never seed attendance.
    for (const link of index.links) if (link.from === sceneKey && catalog.has(link.to)) chosen.set(link.to, '当前场景明确关联');
    const seeds = new Set(chosen.keys());
    for (const id of pinDependencies) if (!chosen.has(id)) chosen.set(id, '固定条目的明确引用依赖');
    for (const link of index.links) {
        if (seeds.has(link.from) && catalog.has(link.to) && !chosen.has(link.to)) chosen.set(link.to, '与固定条目或当前场景条目直接关联');
        if (seeds.has(link.to) && catalog.has(link.from) && !chosen.has(link.from)) chosen.set(link.from, '与固定条目或当前场景条目直接关联');
    }
    // Include endpoints of a selected relationship and direct dependencies of a
    // selected entry, without recursively walking the entire social network.
    const dependents = new Set(chosen.keys());
    for (const link of index.links) if (dependents.has(link.from) && catalog.has(link.to) && !chosen.has(link.to)) chosen.set(link.to, '保留已选条目的明确引用目标');
    // Nested stat/field pins retain their parent record; fields are never cut mid-record.
    for (const id of [...chosen.keys()]) if (id.includes('/')) {
        const parent = id.split('/')[0];
        if (catalog.has(parent) && !chosen.has(parent)) chosen.set(parent, '保留固定或关联字段所属记录');
    }
    // A named scene without any visible explicit reference is not enough to
    // discard the cast. Keep the prior complete projection in that case.
    const fallback = pinnedSet.size === 0 && ![...seeds].some(id => id !== sceneKey);
    const sceneIds = new Set(Object.keys(data.scene?.scenes ?? {}));
    const ambiguousSceneIds = list(data.scene?.schedules).some(row => sceneIds.has(row.id));
    const wholeReason = module => !enabled ? '条目筛选未启用，完整保留'
        : required.get(module) ?? (module === 'scene' && ambiguousSceneIds ? '场景与日程 ID 重复，保留完整场景资料'
            : !Object.hasOwn(collections, module) ? '此模块保留完整结构' : fallback ? '没有可用的场景关联或固定条目，完整保留' : null);
    const keep = (module, record) => Boolean(wholeReason(module) || chosen.has(`${module}:${record.id}`));
    const result = structuredClone(data);
    for (const [module, keys] of Object.entries(collections)) {
        if (!result[module] || wholeReason(module)) continue;
        for (const key of keys) if (Array.isArray(result[module][key])) result[module][key] = result[module][key].filter(record => keep(module, record));
        if (module === 'scene') result.scene.scenes = Object.fromEntries(Object.entries(result.scene.scenes ?? {}).filter(([id, record]) => keep(module, { ...record, id })));
        if (module === 'relationships') {
            const ids = new Set(result.relationships.relationships.map(row => row.id));
            for (const key of ['thresholdRules', 'thresholdAlerts']) if (Array.isArray(result.relationships[key]))
                result.relationships[key] = result.relationships[key].filter(row => ids.has(row.relationshipId));
        }
    }
    const visible = new Set(buildReferenceIndex(result).entities.map(entry => entry.id));
    for (const row of list(result.inventory?.ledger)) visible.add(`inventory:${row.id}`);
    const entries = [...catalog.values()].map(entry => ({ ...entry,
        included: visible.has(entry.id), required: required.has(entry.module) || (enabled && pinDependencies.has(entry.id)),
        reason: wholeReason(entry.module) ?? chosen.get(entry.id) ?? (visible.has(entry.id) ? '所属记录完整保留' : '与当前场景及固定条目无明确关联，本轮略过'),
    }));
    return { data: result, entries, pinnedModules: new Set([...pinDependencies].map(id => catalog.get(id).module)) };
}
