// 规则引擎：全部为纯函数，输入输出为普通对象副本，不触碰存储与 UI。
import { DEFAULT_RULES, clamp, findFaction, findRegion, factionName } from './model.js';
export const INTENSITIES = ['light', 'medium', 'severe'];
export const BATTLE_TYPES = ['skirmish', 'field', 'siege', 'subterfuge', 'diplomacy', 'other'];
export const NO_CONTROLLER = ['无主', '中立', '放弃', 'none', 'null'];
export const TYPE_LABELS = { transfer: '版图变更', population: '人口变动', condition: '状况变动', metric: '指标变动', relation: '关系变动', recovery: '休养生息', created: '棋局创建', regenerate: '全量重生成', edit: '手动编辑', development: '发展', decline: '衰退', diplomacy: '外交', migration: '迁徙', disaster: '灾害' };
export const EVENT_TYPES = Object.keys(TYPE_LABELS);
export const eventTypeOf = (value, fallback) => EVENT_TYPES.includes(value) ? value : (EVENT_TYPES.includes(fallback) ? fallback : 'edit');
// 版图变更方式：仅征服（conquest）触发战乱结算，其余只改归属不动人口状况。
export const CAUSES = ['conquest', 'purchase', 'merge', 'handover', 'other'];
export const CAUSE_LABELS = { conquest: '征服', purchase: '购买', merge: '合并', handover: '和平移交', other: '其他变更' };
// 兼容旧协议：未给 cause 但带 intensity/battleType 的变更视为征服；两者皆无视为其他变更。
const normalizeCause = item => { if (CAUSES.includes(item?.cause)) return item.cause; if (item != null && (item.intensity != null || item.battleType != null)) return 'conquest'; return 'other'; };
const ratio = (value, fallback, min, max) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;

export function normalizeRules(value = {}) {
    const d = DEFAULT_RULES, v = value && typeof value === 'object' ? value : {};
    return {
        intensity: { light: ratio(v.intensity?.light, d.intensity.light, 0, 1), medium: ratio(v.intensity?.medium, d.intensity.medium, 0, 1), severe: ratio(v.intensity?.severe, d.intensity.severe, 0, 1) },
        battleType: Object.fromEntries(BATTLE_TYPES.map(k => [k, ratio(v.battleType?.[k], d.battleType[k], 0, 3)])),
        conditionLoss: { light: ratio(v.conditionLoss?.light, d.conditionLoss.light, 0, 100), medium: ratio(v.conditionLoss?.medium, d.conditionLoss.medium, 0, 100), severe: ratio(v.conditionLoss?.severe, d.conditionLoss.severe, 0, 100) },
        desolationThreshold: ratio(v.desolationThreshold, d.desolationThreshold, 0, 100),
        plagueThreshold: ratio(v.plagueThreshold, d.plagueThreshold, 0, 100),
        plagueWarCount: Math.round(ratio(v.plagueWarCount, d.plagueWarCount, 1, 10)),
        recoveryPerTurn: ratio(v.recoveryPerTurn, d.recoveryPerTurn, 0, 20),
    };
}

// 征服结算：烈度系数 × 战斗类型系数 → 人口损失比例；状况扣减 = 状况烈度基值 × 战斗类型系数。仅征服类易主与战乱损失使用。
export function battleImpact(rules, { intensity = 'medium', battleType = 'field' } = {}) {
    const r = normalizeRules(rules);
    const i = INTENSITIES.includes(intensity) ? intensity : 'medium';
    const t = BATTLE_TYPES.includes(battleType) ? battleType : 'field';
    return { populationRatio: clamp(r.intensity[i] * r.battleType[t], 0, 0.95), conditionLoss: clamp(r.conditionLoss[i] * r.battleType[t], 0, 100), intensity: i, battleType: t };
}

// 状况标签：低于荒芜阈值挂「荒芜」；持续战乱（warTally）或状况触底叠加「瘟疫」。
export function refreshRegionTags(region, rules) {
    const r = normalizeRules(rules), tags = new Set((region.statusTags ?? []).filter(x => typeof x === 'string'));
    if (region.condition < r.desolationThreshold) tags.add('荒芜'); else tags.delete('荒芜');
    if ((region.warTally ?? 0) >= r.plagueWarCount || region.condition <= r.plagueThreshold) tags.add('瘟疫'); else tags.delete('瘟疫');
    region.statusTags = [...tags];
    return region;
}

const snapshot = region => ({ controller: region.controller, population: region.population, condition: region.condition, statusTags: [...region.statusTags], warTally: region.warTally ?? 0 });
const event = (type, description, deltas, at) => ({ ts: at ?? new Date().toISOString(), type, description: description || TYPE_LABELS[type] || type, deltas });

/**
 * 统一结算入口。update 结构（AI 隐藏块 / 盘点建议 / 手动操作共用）：
 * { note, transfers:[{region,to,cause,intensity,battleType,note}], populationDelta:[{region,type,intensity,battleType,ratio}],
 *   conditionDelta:[{region,type,delta}], metricDelta:[{faction,key,type,delta}], relationDelta:[{a,b,delta}] }
 * cause：conquest 征服 / purchase 购买 / merge 合并 / handover 和平移交 / other 其他；仅征服按烈度结算人口与状况。
 * type：可选拒事性质标注（development/decline/diplomacy/migration/disaster 等），未知值回退通道默认类型。
 * 引用一律支持 id 或名称；无法解析的项进入 rejected，静默忽略，不中断其余结算。
 */
export function applyUpdate(campaign, update = {}, at) {
    const next = structuredClone(campaign);
    const rules = normalizeRules(next.rulesConfig);
    const events = [], rejected = [], touched = [];
    const regionOf = item => {
        const region = findRegion(next, item?.region ?? item?.id);
        if (!region) rejected.push({ kind: '地区', ref: String(item?.region ?? ''), reason: '沙盘中没有这个地区' });
        return region;
    };
    const factionOf = (value, kind = '势力') => {
        if (value == null || NO_CONTROLLER.includes(String(value).trim().toLowerCase()) || NO_CONTROLLER.includes(String(value).trim())) return { none: true };
        const faction = findFaction(next, value);
        if (!faction) rejected.push({ kind, ref: String(value), reason: '沙盘中没有这个势力' });
        return faction ?? null;
    };
    for (const item of Array.isArray(update.transfers) ? update.transfers : []) {
        const region = regionOf(item); if (!region) continue;
        const to = factionOf(item?.to); if (to === null) continue;
        const cause = normalizeCause(item);
        const before = snapshot(region);
        let impact = null;
        if (cause === 'conquest') {
            impact = battleImpact(rules, item);
            region.population = Math.max(0, Math.round(region.population * (1 - impact.populationRatio)));
            region.condition = clamp(Math.round(region.condition - impact.conditionLoss), 0, 100);
            region.warTally = (region.warTally ?? 0) + 1;
        }
        const fromName = factionName(next, before.controller);
        region.controller = to.none ? null : to.id;
        touched.push(region.id);
        events.push(event('transfer', item?.note || (fromName + ' → ' + (to.none ? '无主' : to.name) + '（' + CAUSE_LABELS[cause] + '）：' + region.name), { region: region.name, cause, before, after: snapshot(region), ...(impact ? { intensity: impact.intensity, battleType: impact.battleType } : {}) }, at));
    }
    for (const item of Array.isArray(update.populationDelta) ? update.populationDelta : []) {
        const region = regionOf(item); if (!region) continue;
        // ratio 语义与烈度一致：正数为损失比例，负数为增长。
        const explicit = Number.isFinite(Number(item?.ratio)) ? clamp(Number(item.ratio), -0.9, 0.95) : null;
        const impact = battleImpact(rules, item);
        const change = explicit ?? impact.populationRatio;
        const before = snapshot(region);
        region.population = Math.max(0, Math.round(region.population * (1 - change)));
        if (change > 0) { region.warTally = (region.warTally ?? 0) + 1; region.condition = clamp(Math.round(region.condition - impact.conditionLoss), 0, 100); }
        touched.push(region.id);
        events.push(event(eventTypeOf(item?.type, 'population'), item?.note || (region.name + '人口变动'), { region: region.name, before, after: snapshot(region) }, at));
    }
    for (const item of Array.isArray(update.conditionDelta) ? update.conditionDelta : []) {
        const region = regionOf(item); if (!region) continue;
        if (!Number.isFinite(Number(item?.delta))) { rejected.push({ kind: '状况', ref: region.name, reason: '缺少数值' }); continue; }
        const before = snapshot(region);
        region.condition = clamp(Math.round(region.condition + Number(item.delta)), 0, 100);
        touched.push(region.id);
        events.push(event(eventTypeOf(item?.type, 'condition'), item?.note || (region.name + '状况变动'), { region: region.name, before, after: snapshot(region) }, at));
    }
    for (const item of Array.isArray(update.metricDelta) ? update.metricDelta : []) {
        const faction = factionOf(item?.faction ?? item?.region); if (!faction || faction.none || faction === null) continue;
        const metric = faction.metrics.find(m => m.key === item?.key || m.label === item?.key);
        if (!metric) { rejected.push({ kind: '指标', ref: String(item?.key ?? ''), reason: '势力没有这个指标' }); continue; }
        if (!Number.isFinite(Number(item?.delta))) { rejected.push({ kind: '指标', ref: faction.name + '.' + metric.label, reason: '缺少数值' }); continue; }
        const before = metric.value;
        metric.value = clamp(Math.round(metric.value + Number(item.delta)), 0, metric.max ?? 100);
        events.push(event(eventTypeOf(item?.type, 'metric'), item?.note || (faction.name + ' · ' + metric.label), { faction: faction.name, metric: metric.label, before, after: metric.value }, at));
    }
    const relations = [];
    for (const item of Array.isArray(update.relationDelta) ? update.relationDelta : []) {
        const a = factionOf(item?.a); if (!a || a.none || a === null) continue;
        const b = factionOf(item?.b); if (!b || b.none || b === null) continue;
        if (a.id === b.id) { rejected.push({ kind: '关系', ref: a.name, reason: '同一势力不能建立关系' }); continue; }
        if (!Number.isFinite(Number(item?.delta))) { rejected.push({ kind: '关系', ref: a.name + '×' + b.name, reason: '缺少数值' }); continue; }
        const before = a.relations[b.id] ?? 0;
        a.relations[b.id] = clamp(before + Math.round(Number(item.delta)), -100, 100);
        b.relations[a.id] = a.relations[b.id];
        relations.push({ a: a.name, b: b.name, before, after: a.relations[b.id] });
    }
    if (relations.length) events.push(event('relation', update.relationNote || '势力关系变动', { relations }, at));
    for (const region of next.regions) if (touched.includes(region.id)) refreshRegionTags(region, rules);
    next.history.push(...events);
    return { campaign: next, events, rejected };
}

// 和平回合：无战乱地区状况自然恢复、清空连续战乱计数，并维护标签。
export function tickPeace(campaign, at) {
    const next = structuredClone(campaign);
    const rules = normalizeRules(next.rulesConfig);
    const changes = [];
    for (const region of next.regions) {
        const before = snapshot(region);
        region.condition = clamp(region.condition + rules.recoveryPerTurn, 0, 100);
        region.warTally = 0;
        refreshRegionTags(region, rules);
        if (before.condition !== region.condition || before.statusTags.join() !== region.statusTags.join()) changes.push({ region: region.name, before, after: snapshot(region) });
    }
    if (!changes.length) return { campaign: next, events: [] };
    const e = event('recovery', '休养生息：各地状况恢复', { changes }, at);
    next.history.push(e);
    return { campaign: next, events: [e] };
}

// 预览用的可读文案：before/after 主要差异。
export function describeDelta(delta) {
    if (!delta || typeof delta !== 'object') return '';
    const parts = [];
    if (delta.region) {
        const before = delta.before ?? {}, after = delta.after ?? {};
        if (before.controller !== after.controller) parts.push('归属 ' + (before.controller == null ? '无主' : before.controller) + '→' + (after.controller == null ? '无主' : after.controller));
        if (before.population !== after.population) parts.push('人口 ' + before.population + '→' + after.population);
        if (before.condition !== after.condition) parts.push('状况 ' + before.condition + '→' + after.condition);
        const tags = after.statusTags ?? [];
        if ((before.statusTags ?? []).join() !== tags.join()) parts.push('标签 ' + (tags.join('、') || '无'));
    }
    if (delta.faction) parts.push(delta.faction + ' · ' + delta.metric + ' ' + delta.before + '→' + delta.after);
    if (Array.isArray(delta.relations)) for (const r of delta.relations) parts.push(r.a + '×' + r.b + ' ' + r.before + '→' + r.after);
    if (Array.isArray(delta.changes)) for (const c of delta.changes) parts.push(c.region + ' 状况 ' + c.before.condition + '→' + c.after.condition + (c.after.statusTags.length ? '（' + c.after.statusTags.join('、') + '）' : ''));
    if (delta.factions != null && delta.regions != null) parts.push(delta.factions + ' 个势力 · ' + delta.regions + ' 个地区');
    return parts.join('；');
}
