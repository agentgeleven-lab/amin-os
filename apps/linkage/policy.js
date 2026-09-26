export const KEY = 'amin_os_linkage_v1';
export const ROOT = KEY;
export const SCOPE_TEMPLATE_KEY = 'amin_os_linkage_scope_template_v1';
export const MODULES = Object.freeze({
    characters: ['人物卡与外观', 'amin_os_characters_v1'], inventory: ['背包与账本', 'amin_os_inventory_v1'],
    relationships: ['人物关系', 'amin_os_relationships_v1'], scene: ['场景、时间与日程', 'amin_os_scene_v1'],
    journal: ['剧情档案与记忆', 'amin_os_journal_v1'], effects: ['能力与持续效果', 'amin_os_effects_v1'],
    map: ['地图', 'dynamicMapV1'], status: ['世界状态', '状态栏'], organizations: ['势力概览', '势力资料'],
    information: ['信息面板', 'amin_os_information_v1'], dice: ['固定骰点（只读）', 'amin_os_dice_v1'],
});
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
export function validateJSON(value, depth = 0) {
    if (depth > 48) throw Error('联动资料嵌套过深。');
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (Array.isArray(value)) { for (const item of value) validateJSON(item, depth + 1); return; }
    if (!plain(value)) throw Error('联动资料必须是有效 JSON。');
    for (const [key, item] of Object.entries(value)) { if (blocked.has(key)) throw Error('联动资料包含受保护的字段名。'); validateJSON(item, depth + 1); }
}
export const emptyLinkageState = () => ({ version: 1, enabled: false, mode: 'review', modules: {}, extraRules: '', links: [], applied: [] });
export function validateLinkageState(raw) {
    validateJSON(raw);
    if (!plain(raw) || raw.version !== 1 || Object.keys(raw).some(k => !['version','enabled','mode','modules','extraRules','links','applied','dataSource','contextBudget'].includes(k))) throw Error('联动资料版本或字段不兼容。');
    if (typeof raw.enabled !== 'boolean' || !['review', 'auto'].includes(raw.mode) || !plain(raw.modules) || typeof raw.extraRules !== 'string' || raw.extraRules.length > 40000) throw Error('联动设置格式无效。');
    if (raw.contextBudget !== undefined) {
        const budget = raw.contextBudget;
        if (!plain(budget) || Object.keys(budget).some(key => !['enabled', 'maxChars', 'requiredModules', 'entrySelection'].includes(key))
            || typeof budget.enabled !== 'boolean' || !Number.isInteger(budget.maxChars) || budget.maxChars < 1000 || budget.maxChars > 2000000
            || !Array.isArray(budget.requiredModules) || budget.requiredModules.some(id => !own(MODULES, id))
            || new Set(budget.requiredModules).size !== budget.requiredModules.length) throw Error('资料预算需为 1000–2000000 字符，固定模块必须有效且不能重复。');
    }
    if (raw.contextBudget?.entrySelection !== undefined) {
        const selection = raw.contextBudget.entrySelection;
        if (!plain(selection) || Object.keys(selection).some(key => !['enabled', 'pinned'].includes(key))
            || typeof selection.enabled !== 'boolean' || !Array.isArray(selection.pinned) || selection.pinned.length > 2000
            || selection.pinned.some(id => typeof id !== 'string' || id.length > 300 || !own(MODULES, id.split(':')[0]) || !id.split(':').slice(1).join(':') || /[\x00-\x1f]/.test(id))
            || new Set(selection.pinned).size !== selection.pinned.length) throw Error('条目筛选需要有效且不重复的固定条目 ID，最多 2000 项。');
    }
    if (raw.dataSource !== undefined && !['amin','external'].includes(raw.dataSource)) throw Error('请选择有效的资料发送来源。');
    for (const [id, flags] of Object.entries(raw.modules)) {
        if (!own(MODULES, id) || !plain(flags) || Object.keys(flags).some(k => !['enabled', 'read', 'write'].includes(k)) || ['enabled','read','write'].some(k => typeof flags[k] !== 'boolean') || (id === 'dice' && flags.write)) throw Error('联动模块开关无效。');
        if (flags.write && !flags.read) throw Error('允许模型更新的模块必须同时提供当前资料。');
    }
    if (raw.links !== undefined) {
        if (!Array.isArray(raw.links) || raw.links.length > 2000) throw Error('手动关联必须是列表，最多 2000 条。');
        for (const link of raw.links) {
            if (!plain(link) || Object.keys(link).some(k=>!['id','from','to','label'].includes(k)) || typeof link.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(link.id) || typeof link.label !== 'string' || !link.label.trim() || link.label.length > 200) throw Error('手动关联标识或说明无效。');
            for (const key of ['from','to']) if (typeof link[key] !== 'string' || link[key].length > 300 || !Object.hasOwn(MODULES,link[key].split(':')[0]) || !link[key].split(':').slice(1).join(':')) throw Error('手动关联需要完整的模块与条目标识。');
            if (link.from === link.to) throw Error('请选择两个不同的关联条目。');
        }
        if (new Set(raw.links.map(link=>link.id)).size !== raw.links.length || new Set(raw.links.map(link=>JSON.stringify([link.from,link.to,link.label]))).size !== raw.links.length) throw Error('手动关联重复。');
    }
    if (!Array.isArray(raw.applied) || raw.applied.length > 2000) throw Error('联动更新记录格式无效或已达 2000 条上限。');
    for (const record of raw.applied) {
        if (record.archived !== undefined && typeof record.archived !== 'boolean') throw Error('联动历史归档标记无效。');
        if (!plain(record) || typeof record.id !== 'string' || !record.id || typeof record.at !== 'string' || !plain(record.source) || !Array.isArray(record.changes)) throw Error('联动更新来源记录无效。');
        if (typeof record.source.identity !== 'string' || !Array.isArray(record.source.path) || record.source.path.some(v => typeof v !== 'string') || !Number.isInteger(record.source.index) || typeof record.source.text !== 'string') throw Error('联动更新来源不完整。');
    }
    if (new Set(raw.applied.map(r => r.id)).size !== raw.applied.length) throw Error('联动操作编号重复。');
    return { ...structuredClone(raw), links: structuredClone(raw.links ?? []) };
}
export function readLinkageState(ctx) {
    const raw = ctx?.chatMetadata?.[KEY];
    return raw === undefined ? { ...emptyLinkageState(), ...readScopeTemplate(ctx) } : validateLinkageState(raw);
}
// A template carries permissions only, never chat data, rules, IDs or history.
export function scopeTemplate(input) {
    const state = validateLinkageState({ ...emptyLinkageState(), enabled: input?.enabled, modules: input?.modules });
    return { version: 1, enabled: state.enabled, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id,
        state.modules[id] ?? { enabled: false, read: false, write: false }])) };
}
export function readScopeTemplate(ctx) {
    const raw = ctx?.extensionSettings?.[SCOPE_TEMPLATE_KEY];
    if (raw === undefined) return null;
    if (raw?.version !== 1) throw Error('通用联动范围模板版本不兼容。');
    return scopeTemplate(raw);
}
export function moduleAvailable(ctx, id) {
    if (!own(MODULES, id)) return false;
    const key = MODULES[id][1], meta = ctx?.chatMetadata ?? {};
    return id === 'status' || id === 'organizations' ? own(meta.variables ?? {}, key) : own(meta, key);
}
export function modulePolicy(ctx, id) {
    if (!own(MODULES, id)) throw Error('未知联动模块。');
    const saved = readLinkageState(ctx).modules[id];
    if (saved) return saved;
    const enabled = moduleAvailable(ctx, id);
    return { enabled, read: enabled, write: enabled && id !== 'dice' };
}
export function readLinkageSettings(ctx) {
    const { applied, ...settings } = readLinkageState(ctx);
    settings.modules = Object.fromEntries(Object.keys(MODULES).map(id => [id, modulePolicy(ctx, id)]));
    return settings;
}
export function managesModule(ctx, id) {
    try { return readLinkageState(ctx).enabled && modulePolicy(ctx, id).enabled; }
    catch { return false; }
}
export function mayRead(ctx, id) { return managesModule(ctx, id) && modulePolicy(ctx, id).read; }
export function mayWrite(ctx, id) { return managesModule(ctx, id) && modulePolicy(ctx, id).read && modulePolicy(ctx, id).write && id !== 'dice'; }
