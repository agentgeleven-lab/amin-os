import { template, TEMPLATES } from './templates.js';
export const CAMPAIGN_VERSION = 1;
export const uid = () => (globalThis.crypto?.randomUUID?.() ?? 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const text = (value, limit = 60) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

// 保守中间值：规则系数全部可通过 campaign.rulesConfig 覆盖（见 rules.normalizeRules）。
export const DEFAULT_RULES = Object.freeze({
    intensity: { light: 0.05, medium: 0.12, severe: 0.25 },
    battleType: { skirmish: 0.7, field: 1, siege: 1.5, subterfuge: 0.35, diplomacy: 0.1, other: 0.5 },
    conditionLoss: { light: 6, medium: 14, severe: 28 },
    desolationThreshold: 25,
    plagueThreshold: 12,
    plagueWarCount: 2,
    recoveryPerTurn: 2,
});

export function defaultMetrics(scaleTemplate) {
    const set = template(scaleTemplate)?.metrics ?? TEMPLATES.street.metrics;
    return set.map(m => ({ key: m.key, label: m.label, value: 50, max: m.max }));
}

export function createCampaign({ scaleTemplate = 'street', name = '', description = '' } = {}) {
    if (!template(scaleTemplate)) throw Error('未知的规模模板：' + scaleTemplate);
    const tpl = template(scaleTemplate);
    const campaign = {
        version: CAMPAIGN_VERSION, id: uid(), createdAt: new Date().toISOString(),
        name: text(name) || tpl.name + '棋局', description: text(description, 300),
        scaleTemplate, rulesConfig: structuredClone(DEFAULT_RULES),
        factions: [], regions: [], history: [],
    };
    campaign.history.push({ ts: campaign.createdAt, type: 'created', description: '创建棋局「' + campaign.name + '」（' + tpl.name + '）', deltas: {} });
    return campaign;
}

export function createFaction(campaign, data = {}) {
    const name = text(data.name);
    if (!name) throw Error('请填写势力名称');
    if (campaign.factions.some(f => f.name === name)) throw Error('已存在同名势力：' + name);
    const tpl = template(campaign.scaleTemplate);
    const metrics = Array.isArray(data.metrics) && data.metrics.length ? data.metrics : defaultMetrics(campaign.scaleTemplate);
    const ideologies = (Array.isArray(data.ideologies) ? data.ideologies : []).map(i => ({ name: text(i?.name ?? i, 40), weight: clamp(number(i?.weight, 20), 0, 100) })).filter(i => i.name);
    const faction = {
        id: data.id ? String(data.id) : uid(), name,
        color: /^#[0-9a-f]{6}$/i.test(String(data.color)) ? String(data.color) : (tpl?.colors?.[campaign.factions.length % (tpl.colors?.length ?? 1)] ?? '#888888'),
        icon: text(data.icon, 12), motto: text(data.motto, 120),
        metrics: normalizeMetrics(metrics, campaign.scaleTemplate),
        ideologies, traits: (Array.isArray(data.traits) ? data.traits : String(data.traits ?? '').split(/[,，、\n]/)).map(t => text(t, 30)).filter(Boolean),
        relations: {},
    };
    for (const other of campaign.factions) { faction.relations[other.id] = 0; other.relations[faction.id] = 0; }
    return faction;
}

export function createRegion(campaign, data = {}) {
    const name = text(data.name);
    if (!name) throw Error('请填写地区名称');
    if (campaign.regions.some(r => r.name === name)) throw Error('已存在同名地区：' + name);
    const pop = template(campaign.scaleTemplate)?.population ?? { min: 10, max: 100 };
    const population = data.population === undefined || data.population === null || data.population === ''
        ? Math.round((pop.min + pop.max) / 2) : Math.max(0, Math.round(number(data.population, pop.min)));
    const controller = campaign.factions.find(f => f.id === data.controller || f.name === data.controller)?.id ?? null;
    return {
        id: data.id ? String(data.id) : uid(), name, mapRef: text(data.mapRef, 120),
        controller, population, condition: clamp(Math.round(number(data.condition, 70)), 0, 100),
        statusTags: (Array.isArray(data.statusTags) ? data.statusTags : []).map(t => text(t, 12)).filter(Boolean),
        warTally: 0, localMetrics: [],
    };
}

function normalizeMetrics(metrics, scaleTemplate) {
    const known = defaultMetrics(scaleTemplate);
    const result = structuredClone(known);
    for (const m of Array.isArray(metrics) ? metrics : []) {
        const key = typeof m?.key === 'string' ? m.key : known.find(k => k.label === m?.label)?.key;
        const slot = result.find(r => r.key === key) ?? (m?.key && m?.label ? null : undefined);
        if (slot) { slot.value = clamp(Math.round(number(m?.value, slot.value)), 0, slot.max ?? 100); }
        else if (m?.key && m?.label) result.push({ key: String(m.key), label: text(m.label, 20), value: clamp(Math.round(number(m.value, 50)), 0, number(m.max, 100)) , max: number(m.max, 100) });
    }
    return result;
}

export function normalizeCampaign(raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('棋局数据不是对象');
    const scaleTemplate = template(raw.scaleTemplate) ? raw.scaleTemplate : (template(options.scaleTemplate) ? options.scaleTemplate : 'street');
    const campaign = {
        version: CAMPAIGN_VERSION, id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
        createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
        name: text(raw.name) || text(options.name) || (template(scaleTemplate)?.name ?? '') + '棋局',
        description: text(raw.description, 300), scaleTemplate,
        rulesConfig: raw.rulesConfig && typeof raw.rulesConfig === 'object' ? raw.rulesConfig : structuredClone(DEFAULT_RULES),
        factions: [], regions: [], history: [],
    };
    const seen = new Set();
    for (const f of Array.isArray(raw.factions) ? raw.factions : []) {
        if (!f || typeof f !== 'object' || seen.has(f.name)) continue;
        const faction = createFaction(campaign, {
            id: typeof f.id === 'string' ? f.id : undefined, name: f.name, color: f.color, icon: f.icon, motto: f.motto,
            metrics: f.metrics, ideologies: f.ideologies, traits: f.traits,
        });
        seen.add(faction.name); campaign.factions.push(faction);
    }
    for (const r of Array.isArray(raw.regions) ? raw.regions : []) {
        if (!r || typeof r !== 'object') continue;
        try {
            const region = createRegion(campaign, r);
            region.warTally = clamp(Math.round(number(r.warTally, 0)), 0, 99);
            region.mapRef = text(r.mapRef, 120);
            if (Array.isArray(r.localMetrics)) region.localMetrics = r.localMetrics.filter(m => m && typeof m === 'object').map(m => ({ key: text(m.key, 30), label: text(m.label, 20), value: number(m.value, 0) }));
            if (!campaign.regions.some(x => x.name === region.name)) campaign.regions.push(region);
        } catch { /* 同名/非法地区跳过 */ }
    }
    for (const f of campaign.factions) {
        const source = (Array.isArray(raw.factions) ? raw.factions : []).find(x => x?.name === f.name);
        const relations = source?.relations && typeof source.relations === 'object' ? source.relations : {};
        for (const other of campaign.factions) if (other.id !== f.id) f.relations[other.id] = clamp(Math.round(number(relations[other.id] ?? relations[other.name] ?? 0, 0)), -100, 100);
    }
    // 关系镜像：不对称时取非零一侧，保证双向一致。
    for (let i = 0; i < campaign.factions.length; i++) for (let j = i + 1; j < campaign.factions.length; j++) {
        const a = campaign.factions[i], b = campaign.factions[j];
        const value = (a.relations[b.id] ?? 0) !== 0 ? a.relations[b.id] : (b.relations[a.id] ?? 0);
        a.relations[b.id] = value; b.relations[a.id] = value;
    }
    for (const e of Array.isArray(raw.history) ? raw.history : []) {
        if (!e || typeof e !== 'object' || typeof e.ts !== 'string') continue;
        campaign.history.push({ ts: e.ts, type: text(e.type, 20) || 'edit', description: text(e.description, 400), deltas: e.deltas && typeof e.deltas === 'object' ? e.deltas : {} });
    }
    if (options.event) campaign.history.push({ ts: new Date().toISOString(), type: options.event.type ?? 'edit', description: options.event.description ?? '', deltas: options.event.deltas ?? {} });
    return campaign;
}

// AI 输出的整套棋局（或建盘结果）：metrics 允许 {标签:数值}；controller 用势力名。
export function importBoard(raw, { scaleTemplate, name, keepId, keepHistory } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const factions = (Array.isArray(source.factions) ? source.factions : []).map(f => {
        const metrics = f?.metrics && !Array.isArray(f.metrics) && typeof f.metrics === 'object'
            ? Object.entries(f.metrics).map(([label, value]) => ({ label, value: number(value, 50) }))
            : f?.metrics;
        return { ...f, metrics };
    });
    const regions = (Array.isArray(source.regions) ? source.regions : []).map(r => ({ ...r }));
    const draft = { ...source, factions, regions, scaleTemplate: template(scaleTemplate) ? scaleTemplate : (template(source.scaleTemplate) ? source.scaleTemplate : undefined) };
    const base = normalizeCampaign(draft, { scaleTemplate, name });
    if (!base.factions.length || !base.regions.length) throw Error('AI 结果缺少势力或地区，未导入');
    const current = keepId && typeof keepId === 'object' ? keepId : null;
    if (current) {
        base.id = current.id; base.createdAt = current.createdAt;
        if (keepHistory !== false) base.history = [...current.history];
        base.history.push({ ts: new Date().toISOString(), type: 'regenerate', description: text(source.note ?? source.summary, 200) || '按当前剧情全量重生成沙盘', deltas: { factions: base.factions.length, regions: base.regions.length } });
    }
    return base;
}

export function findFaction(campaign, ref) {
    if (ref == null || ref === '') return null;
    return campaign.factions.find(f => f.id === ref || f.name === ref) ?? null;
}
export function findRegion(campaign, ref) {
    if (ref == null || ref === '') return null;
    return campaign.regions.find(r => r.id === ref || r.name === ref) ?? null;
}
export const factionName = (campaign, id) => campaign.factions.find(f => f.id === id)?.name ?? '无主';
export const territoryCount = (campaign, factionId) => campaign.regions.filter(r => r.controller === factionId).length;

export function campaignDigest(campaign) {
    return {
        name: campaign.name, scaleTemplate: campaign.scaleTemplate,
        factions: campaign.factions.map(f => ({ name: f.name, metrics: f.metrics.map(m => m.label + '=' + m.value) })),
        regions: campaign.regions.map(r => ({ name: r.name, controller: factionName(campaign, r.controller), population: r.population, condition: r.condition, tags: r.statusTags })),
        relations: campaign.factions.flatMap(a => campaign.factions.filter(b => b.id > a.id).map(b => ({ a: a.name, b: b.name, value: a.relations[b.id] ?? 0 }))).filter(x => x.value !== 0),
    };
}
