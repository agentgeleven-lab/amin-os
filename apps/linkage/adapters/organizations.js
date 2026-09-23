import { ROOT, GROUPS, FIELDS, LINKS, entity, read, validate, enforceLocks, diff } from '../../organizations/model.js';

const META = 'amin_os_organizations_v1', HISTORY = 'amin_os_organizations_history_v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
function source(ctx) {
    const doc = read(ctx?.chatMetadata?.variables?.[ROOT]);
    const raw = ctx?.chatMetadata?.[META];
    if (raw !== undefined && (!object(raw) || raw.locks !== undefined && (!Array.isArray(raw.locks) || raw.locks.some(path => typeof path !== 'string')) || raw.backups !== undefined && !Array.isArray(raw.backups))) throw Error('势力元数据格式无效，原始资料未改写。');
    const extra = clone(raw ?? {}), locks = extra.locks ?? [];
    enforceLocks(doc, doc, locks);
    return { doc, extra, locks };
}
function historyPatch(ctx, doc, assessment, timestamp) {
    const raw = ctx?.chatMetadata?.[HISTORY];
    if (raw !== undefined && (!object(raw) || !object(raw.records))) throw Error('势力楼层历史格式无效，未写入。');
    const tail = ctx?.chat?.at(-1), id = tail?.extra?.amin_org_message_id;
    if (!id) return [];
    if (typeof id !== 'string') throw Error('势力楼层标识无效。');
    const next = clone(raw ?? { records: {} }), key = id + ':' + String(tail.swipe_id ?? 0);
    next.records[key] = { ...next.records[key], state: { doc: clone(doc), assessment: clone(assessment ?? null) }, savedAt: timestamp };
    return [{ path: [HISTORY], value: next }];
}

export const adapter = {
    id: 'organizations', label: '势力资料',
    paths: [['variables', ROOT], [META], [HISTORY]],
    contract: 'create/update: target=全局唯一主体 ID, data={group:"organizations"|"alliances"|"regions",fields:{待建立/修改字段}}。create 必须含 fields.name；update 仅修改既有主体，不更换 ID/group。文本字段沿用当前主体，metrics 使用 {key,label,unit,source,kind:"number"|"range"|"text"|"unknown",value}；relations/members/controllers 使用 {organization:已有组织ID,role,note} 数组，地区 parent 为已有地区ID或null。所有 locked 路径禁止修改。禁止删除和整体替换资料。',
    read(ctx) { const { doc, locks } = source(ctx); return { version: 1, doc, locks }; },
    apply(ctx, change, { now } = {}) {
        if (change?.module !== 'organizations' || !['create', 'update'].includes(change.action)) throw Error('不支持的势力联动操作。');
        if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 4000) throw Error('势力更新需要明确依据。');
        const data = change.data;
        if (!object(data) || Object.keys(data).some(key => !['group', 'fields'].includes(key)) || !GROUPS.includes(data.group) || !object(data.fields) || !Object.keys(data.fields).length) throw Error('势力更新格式无效。');
        if (typeof change.target !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(change.target) || ['constructor', 'prototype', '__proto__'].includes(change.target)) throw Error('势力主体 ID 无效。');
        const allowed = [...Object.keys(FIELDS[data.group]), ...Object.keys(LINKS[data.group]), 'metrics'];
        if (Object.keys(data.fields).some(key => !allowed.includes(key))) throw Error('势力更新包含未允许的字段。');
        const { doc: before, extra, locks } = source(ctx), next = clone(before);
        const found = GROUPS.find(group => Object.hasOwn(before[group], change.target));
        if (change.action === 'create') {
            if (found) throw Error('势力主体 ID 已存在。');
            if (typeof data.fields.name !== 'string' || !data.fields.name.trim()) throw Error('创建势力资料需要名称。');
            next[data.group][change.target] = { ...entity(data.group, data.fields.name), ...clone(data.fields) };
        } else {
            if (found !== data.group) throw Error('势力主体不存在或所属分类不匹配。');
            next[data.group][change.target] = { ...next[data.group][change.target], ...clone(data.fields) };
        }
        validate(next); enforceLocks(before, next, locks);
        const timestamp = typeof now === 'number' ? now : Date.parse(now);
        if (!Number.isFinite(timestamp)) throw Error('联动更新时间无效。');
        const backups = [...(extra.backups ?? []), { doc: clone(before), at: timestamp }].slice(-5);
        const patches = [{ path: ['variables', ROOT], value: JSON.stringify(next) }, { path: [META, 'backups'], value: backups }, ...historyPatch(ctx, next, extra.assessment, timestamp)];
        return { patches, summary: `势力资料 ${next[data.group][change.target].name}：${diff(before, next).length} 项变化` };
    },
};
