import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign, createFaction, createRegion, DEFAULT_RULES } from '../model.js';
import { battleImpact, applyUpdate, tickPeace, normalizeRules, refreshRegionTags } from '../rules.js';

function board({ population = 1000, condition = 100, rules } = {}) {
    const campaign = createCampaign({ scaleTemplate: 'street', name: '测试棋局' });
    if (rules) campaign.rulesConfig = rules;
    const a = createFaction(campaign, { name: '甲' }), b = createFaction(campaign, { name: '乙' });
    campaign.factions.push(a, b);
    campaign.regions.push(createRegion(campaign, { name: '东城', controller: a.id, population, condition }));
    return campaign;
}

test('battle impact multiplies intensity by battle type with safe fallbacks', () => {
    assert.deepEqual(battleImpact(DEFAULT_RULES, { intensity: 'medium', battleType: 'field' }), { populationRatio: 0.12, conditionLoss: 14, intensity: 'medium', battleType: 'field' });
    const siege = battleImpact(DEFAULT_RULES, { intensity: 'severe', battleType: 'siege' });
    assert.equal(siege.populationRatio, 0.25 * 1.5);
    assert.equal(siege.conditionLoss, 28 * 1.5);
    const fallback = battleImpact(DEFAULT_RULES, { intensity: 'total-war', battleType: '金融战' });
    assert.equal(fallback.intensity, 'medium'); assert.equal(fallback.battleType, 'field');
});

test('transfer settles relative population and condition, then records history', () => {
    const campaign = board();
    const { campaign: next, events, rejected } = applyUpdate(campaign, { transfers: [{ region: '东城', to: '乙', intensity: 'medium', battleType: 'field', note: '夜袭易主' }] });
    const region = next.regions[0];
    assert.equal(region.controller, next.factions[1].id);
    assert.equal(region.population, 880, '1000 × (1 - 0.12)');
    assert.equal(region.condition, 86);
    assert.equal(region.warTally, 1);
    assert.deepEqual(region.statusTags, [], '86 高于荒芜阈值');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'transfer');
    assert.equal(events[0].deltas.before.controller, campaign.factions[0].id);
    assert.equal(next.history.length, campaign.history.length + 1, '事件进入战报');
    assert.deepEqual(rejected, []);
    assert.equal(campaign.regions[0].controller, campaign.factions[0].id, '原棋局不被修改');
});

test('the same intensity costs the same share for big and small populations', () => {
    const big = board({ population: 1000 }), small = board({ population: 100 });
    const bigNext = applyUpdate(big, { transfers: [{ region: '东城', to: '乙', intensity: 'severe', battleType: 'siege' }] }).campaign;
    const smallNext = applyUpdate(small, { transfers: [{ region: '东城', to: '乙', intensity: 'severe', battleType: 'siege' }] }).campaign;
    assert.equal(bigNext.regions[0].population, 625);
    assert.equal(smallNext.regions[0].population, 63);
});

test('condition below threshold adds desolation and sustained war adds plague', () => {
    let { campaign } = applyUpdate(board(), { transfers: [{ region: '东城', to: '乙', intensity: 'severe', battleType: 'siege' }] });
    let region = campaign.regions[0];
    assert.equal(region.condition, 58);
    assert.deepEqual(region.statusTags, [], '一次惨烈围攻还不到荒芜');
    ({ campaign } = applyUpdate(campaign, { transfers: [{ region: '东城', to: '甲', intensity: 'severe', battleType: 'siege' }] }));
    region = campaign.regions[0];
    assert.equal(region.condition, 16, '58 - 42');
    assert.ok(region.statusTags.includes('荒芜'), '低于荒芜阈值');
    assert.ok(region.statusTags.includes('瘟疫'), '连续战乱两次叠加瘟疫');
    ({ campaign } = applyUpdate(campaign, { conditionDelta: [{ region: '东城', delta: 40 }] }));
    region = campaign.regions[0];
    assert.equal(region.condition, 56);
    assert.deepEqual(region.statusTags, ['瘟疫'], '状况回升但连续战乱未断，瘟疫保留');
    ({ campaign } = tickPeace(campaign));
    region = campaign.regions[0];
    assert.deepEqual(region.statusTags, [], '休养生息清零战乱计数后标签解除');
});

test('refreshRegionTags honours configured thresholds', () => {
    const desolate = { condition: 20, warTally: 0, statusTags: [] };
    refreshRegionTags(desolate, { desolationThreshold: 25, plagueThreshold: 12, plagueWarCount: 2 });
    assert.deepEqual(desolate.statusTags, ['荒芜'], '低于荒芜阈值但战乱不足，只挂荒芜');
    const bottom = { condition: 10, warTally: 0, statusTags: [] };
    refreshRegionTags(bottom, { desolationThreshold: 25, plagueThreshold: 12, plagueWarCount: 2 });
    assert.deepEqual(bottom.statusTags, ['荒芜', '瘟疫'], '状况触底叠加瘟疫');
    const endlessWar = { condition: 60, warTally: 2, statusTags: [] };
    refreshRegionTags(endlessWar, { desolationThreshold: 25, plagueThreshold: 12, plagueWarCount: 2 });
    assert.deepEqual(endlessWar.statusTags, ['瘟疫'], '连续战乱叠加瘟疫');
});

test('unknown references are rejected silently without breaking the rest', () => {
    const campaign = board();
    const { campaign: next, events, rejected } = applyUpdate(campaign, {
        note: '混合更新',
        transfers: [{ region: '不存在的城', to: '乙' }, { region: '东城', to: '查无此帮' }],
        metricDelta: [{ faction: '甲', key: 'cash', delta: -25 }, { faction: '乙', key: '魔法值', delta: 5 }, { faction: '甲', key: '声望' }],
    });
    assert.equal(next.regions[0].controller, campaign.factions[0].id, '易主全部被拒');
    assert.equal(next.factions[0].metrics.find(m => m.key === 'cash').value, 25, '合法指标仍结算');
    assert.equal(events.length, 1);
    assert.equal(rejected.length, 4, '未知地区、未知势力、未知指标、缺少数值');
    assert.equal(next.history.length, campaign.history.length + 1);
});

test('transfer to a null owner label releases the region', () => {
    const campaign = board();
    const { campaign: next } = applyUpdate(campaign, { transfers: [{ region: '东城', to: '无主', intensity: 'light', battleType: 'diplomacy' }] });
    assert.equal(next.regions[0].controller, null);
});

test('metric and relation updates clamp to bounds and mirror both sides', () => {
    const campaign = board();
    const { campaign: next, events } = applyUpdate(campaign, {
        metricDelta: [
            { faction: '甲', key: 'cash', delta: -500 },
            { faction: '乙', key: 'manpower', delta: 30 },
        ],
        relationDelta: [
            { a: '甲', b: '乙', delta: -180 },
            { a: '甲', b: '甲', delta: 50 },
        ],
    });
    assert.equal(next.factions[0].metrics.find(m => m.key === 'cash').value, 0);
    assert.equal(next.factions[1].metrics.find(m => m.key === 'manpower').value, 80);
    assert.equal(next.factions[0].relations[next.factions[1].id], -100);
    assert.equal(next.factions[1].relations[next.factions[0].id], -100, '关系镜像');
    assert.equal(events.filter(e => e.type === 'metric').length, 2);
    assert.equal(events.filter(e => e.type === 'relation').length, 1, '自己与自己被忽略');
});

test('populationDelta settles by intensity or explicit ratio and recovers by negative ratio', () => {
    const campaign = board();
    const hit = applyUpdate(campaign, { populationDelta: [{ region: '东城', intensity: 'medium', battleType: 'field' }] }).campaign;
    assert.equal(hit.regions[0].population, 880);
    assert.equal(hit.regions[0].condition, 86, '损失同时扣状况');
    const grow = applyUpdate(hit, { populationDelta: [{ region: '东城', ratio: -0.5 }] }).campaign;
    assert.equal(grow.regions[0].population, 1320, '负比例为增长');
    assert.equal(grow.regions[0].condition, 86, '增长不动状况');
});

test('configurable rulesConfig changes every settlement', () => {
    const strict = board({ rules: { ...DEFAULT_RULES, intensity: { ...DEFAULT_RULES.intensity, medium: 0.5 }, conditionLoss: { ...DEFAULT_RULES.conditionLoss, medium: 40 } } });
    const { campaign } = applyUpdate(strict, { transfers: [{ region: '东城', to: '乙', intensity: 'medium', battleType: 'field' }] });
    assert.equal(campaign.regions[0].population, 500);
    assert.equal(campaign.regions[0].condition, 60);
    const normalized = normalizeRules({ intensity: { medium: 99 }, battleType: { siege: -3 }, plagueWarCount: 0, recoveryPerTurn: 999 });
    assert.equal(normalized.intensity.medium, 1, '系数夹回 0..1');
    assert.equal(normalized.battleType.siege, 0);
    assert.equal(normalized.plagueWarCount, 1);
    assert.equal(normalized.recoveryPerTurn, 20);
    assert.deepEqual(normalizeRules(null), normalizeRules(DEFAULT_RULES), '空配置回到保守默认');
});

test('tickPeace recovers condition, clears war tally and maintains tags', () => {
    let { campaign } = applyUpdate(board({ condition: 40 }), { transfers: [{ region: '东城', to: '乙', intensity: 'severe', battleType: 'field' }] });
    assert.deepEqual(campaign.regions[0].statusTags, ['荒芜', '瘟疫']);
    const peace = tickPeace(campaign);
    assert.equal(peace.campaign.regions[0].condition, 14);
    assert.equal(peace.campaign.regions[0].warTally, 0);
    assert.deepEqual(peace.campaign.regions[0].statusTags, ['荒芜'], '战乱计数清零，状况 14 仍荒芜');
    assert.equal(peace.events.length, 1);
    assert.equal(peace.campaign.history.length, campaign.history.length + 1);
    let healed = peace.campaign;
    for (let i = 0; i < 50 && healed.regions[0].condition < 100; i++) healed = tickPeace(healed).campaign;
    assert.equal(healed.regions[0].condition, 100);
    assert.deepEqual(healed.regions[0].statusTags, []);
    const idle = tickPeace(healed);
    assert.deepEqual(idle.events, [], '满状况时不产生战报');
});
