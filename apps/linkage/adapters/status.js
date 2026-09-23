import { validateTemplate, valueType, mergeUpdates } from '../../status/state-tools.js';
import { bindingParts } from '../../characters/model.js';

const ROOT = '状态栏', HISTORY = 'world_status_hud_history_v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const exact = (value, fields) => {
    if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('状态更新包含未知字段或格式无效。');
};
const numeric = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw Error('状态数值必须是安全范围内的有限数字。');
    return value;
};
function state(ctx) {
    const raw = ctx?.chatMetadata?.variables?.[ROOT];
    if (raw === undefined || raw === null || raw === '') return { 版本: 1, 项目: {} };
    let value;
    try { value = typeof raw === 'string' ? JSON.parse(raw) : clone(raw); }
    catch { throw Error('世界状态无法解析，原始资料未改写。'); }
    if (!object(value) || value.版本 !== undefined && value.版本 !== 1) throw Error('世界状态版本不兼容，原始资料未改写。');
    return clone(validateTemplate(value));
}
function historyPatch(ctx, value, now) {
    const original = ctx?.chatMetadata?.[HISTORY];
    if (original !== undefined && (!object(original) || !object(original.records))) throw Error('世界状态楼层历史格式无效，未写入。');
    const tail = ctx?.chat?.at(-1), id = tail?.extra?.wsh_message_id;
    // The host history bridge assigns message IDs. A metadata-only adapter must
    // not modify a chat message or erase earlier evidence when one is absent.
    if (!id) return [];
    if (typeof id !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(id)) throw Error('世界状态楼层标识无效。');
    const timestamp = typeof now === 'number' ? now : Date.parse(now);
    if (!Number.isFinite(timestamp)) throw Error('联动更新时间无效。');
    const next = clone(original ?? { records: {} }), key = id + ':' + String(tail.swipe_id ?? 0);
    next.records[key] = { ...next.records[key], state: clone(value), savedAt: timestamp };
    return [{ path: [HISTORY], value: next }];
}

export const adapter = {
    id: 'status', label: '世界状态',
    paths: [['variables', ROOT], [HISTORY]],
    contract: 'set: target="项目名.字段名", data={value: 与现有字段同类型的值, component?: "value"|"current"|"max"}; adjust: target 同上, data={delta: 有限数字, component?: "value"|"current"|"max"}。value/省略 component 指整个字段；current/max 仅适用于进度的当前/最大。只更新已有字段，不新增、删除、重命名或改变类型；进度保持 0≤当前≤最大、最大>0，不自动截断。',
    read: state,
    apply(ctx, change, { now } = {}) {
        if (change?.module !== 'status' || !['set', 'adjust'].includes(change.action)) throw Error('不支持的世界状态联动操作。');
        if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 4000) throw Error('世界状态更新需要明确依据。');
        exact(change.data, change.action === 'set' ? ['value', 'component'] : ['delta', 'component']);
        const current = state(ctx), [project, field] = bindingParts(change.target);
        if (!Object.hasOwn(current.项目, project) || !Object.hasOwn(current.项目[project], field)) throw Error('世界状态目标字段不存在：' + change.target);
        const before = current.项目[project][field], component = change.data.component ?? 'value';
        if (!['value', 'current', 'max'].includes(component)) throw Error('世界状态数值部分无效。');
        let value = clone(before);
        if (component !== 'value') {
            if (valueType(before) !== '进度') throw Error('只有进度字段可以更新当前值或最大值。');
            const key = component === 'current' ? '当前' : '最大';
            value[key] = numeric(change.action === 'set' ? change.data.value : numeric(before[key]) + numeric(change.data.delta));
        } else if (change.action === 'adjust') {
            if (valueType(before) !== '数字') throw Error('增减操作仅适用于数字字段或进度的数值部分。');
            value = numeric(before + numeric(change.data.delta));
        } else {
            if (!Object.hasOwn(change.data, 'value')) throw Error('状态更新缺少 value。');
            value = clone(change.data.value);
            if (typeof value === 'number') numeric(value);
        }
        if (valueType(value) === '不支持' || valueType(value) !== valueType(before)) throw Error('不允许改变状态字段类型或写入越界进度。');
        const result = mergeUpdates(current, current, { 项目: { [project]: { [field]: value } } });
        const patches = [{ path: ['variables', ROOT], value: JSON.stringify(result.state) }, ...historyPatch(ctx, result.state, now)];
        return { patches, summary: `世界状态 ${change.target}${component === 'value' ? '' : component === 'current' ? ' · 当前' : ' · 最大'}：${JSON.stringify(before)} → ${JSON.stringify(value)}` };
    },
};
