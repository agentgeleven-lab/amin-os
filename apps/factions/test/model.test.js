import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign, createFaction, createRegion, normalizeCampaign, importBoard, campaignDigest, defaultMetrics } from '../model.js';
import { TEMPLATES } from '../templates.js';

test('all four scale templates create campaigns with their own metric sets', () => {
    for (const id of Object.keys(TEMPLATES)) {
        const campaign = createCampaign({ scaleTemplate: id, name: '棋局·' + id });
        assert.equal(campaign.scaleTemplate, id);
        assert.equal(campaign.factions.length, 0);
        assert.equal(campaign.history[0].type, 'created');
        const faction = createFaction(campaign, { name: '测试势力' });
        assert.deepEqual(faction.metrics.map(m => m.key), TEMPLATES[id].metrics.map(m => m.key));
        assert.ok(faction.metrics.every(m => m.value === 50));
        assert.match(faction.color, /^#[0-9a-f]{6}$/i);
        const region = createRegion(campaign, { name: TEMPLATES[id].regionNouns[0] });
        assert.equal(region.controller, null);
        assert.equal(region.condition, 70);
        assert.deepEqual(region.statusTags, []);
        assert.ok(region.population >= TEMPLATES[id].population.min && region.population <= TEMPLATES[id].population.max);
    }
});

test('createCampaign rejects unknown templates and blank names fall back', () => {
    assert.throws(() => createCampaign({ scaleTemplate: 'galaxy' }), /未知的规模模板/);
    const campaign = createCampaign({ scaleTemplate: 'court' });
    assert.equal(campaign.name, '朝堂权斗棋局');
});

test('normalizeCampaign repairs broken input, controllers and relations', () => {
    const raw = {
        name: '修复棋局', scaleTemplate: 'street',
        factions: [
            { name: '甲', metrics: [{ key: 'manpower', value: 900 }], relations: { 乙: -30 } },
            { name: '乙', relations: {} },
            { name: '甲' },
            null,
        ],
        regions: [
            { name: '东城', controller: '甲', population: 120, condition: 200 },
            { name: '西城', controller: '查无此势力', population: -5 },
            { name: '东城', controller: '乙' },
        ],
        history: [{ ts: '2024-01-01T00:00:00.000Z', type: 'transfer', description: '旧战报', deltas: {} }, { broken: true }],
    };
    const campaign = normalizeCampaign(raw);
    assert.deepEqual(campaign.factions.map(f => f.name), ['甲', '乙']);
    assert.equal(campaign.factions[0].metrics.find(m => m.key === 'manpower').value, 100, '指标夹回 0..max');
    assert.equal(campaign.factions[0].metrics.length, TEMPLATES.street.metrics.length, '补齐模板缺失指标');
    assert.equal(campaign.factions[0].relations[campaign.factions[1].id], -30, '按势力名对齐关系');
    assert.equal(campaign.factions[1].relations[campaign.factions[0].id], -30, '关系镜像同步');
    assert.deepEqual(campaign.regions.map(r => r.name), ['东城', '西城'], '同名地区只保留一个');
    assert.equal(campaign.regions[0].controller, campaign.factions[0].id);
    assert.equal(campaign.regions[1].controller, null, '未知势力归无主');
    assert.equal(campaign.regions[1].population, 0);
    assert.equal(campaign.regions[0].condition, 100, '状况夹回 0..100');
    assert.equal(campaign.history.length, 1);
    assert.equal(campaign.history[0].description, '旧战报');
});

test('normalizeCampaign throws on non-object payloads', () => {
    assert.throws(() => normalizeCampaign(null), /不是对象/);
    assert.throws(() => normalizeCampaign('text'), /不是对象/);
});

test('importBoard maps AI labels and controller names onto template metrics', () => {
    const board = importBoard({
        name: 'AI 棋局', note: '初建',
        factions: [{ name: '红帮', color: '#e0564a', metrics: { 人手: 70, 现金: 30 }, ideologies: [{ name: '守旧', weight: 60 }, { name: '革新', weight: 40 }], traits: ['狠', '排外'] }],
        regions: [{ name: '码头', controller: '红帮', population: 120, condition: 50 }, { name: '市场', controller: '红帮' }],
    }, { scaleTemplate: 'street' });
    assert.equal(board.name, 'AI 棋局');
    const faction = board.factions[0];
    assert.equal(faction.metrics.find(m => m.key === 'manpower').value, 70);
    assert.equal(faction.metrics.find(m => m.key === 'cash').value, 30);
    assert.deepEqual(faction.traits, ['狠', '排外']);
    assert.equal(board.regions[0].controller, faction.id);
    assert.equal(board.regions[0].condition, 50);
    assert.equal(board.regions[1].population, Math.round((TEMPLATES.street.population.min + TEMPLATES.street.population.max) / 2), '缺省人口取模板中值');
});

test('importBoard keeps identity and appends regenerate event when replacing', () => {
    const current = createCampaign({ scaleTemplate: 'interstate', name: '旧棋局' });
    const before = current.history.length;
    const board = importBoard({
        factions: [{ name: '北军' }, { name: '南军' }], regions: [{ name: '北省', controller: '北军' }],
    }, { scaleTemplate: 'interstate', keepId: current });
    assert.equal(board.id, current.id);
    assert.equal(board.history.length, before + 1);
    assert.equal(board.history.at(-1).type, 'regenerate');
});

test('importBoard refuses boards without factions or regions', () => {
    assert.throws(() => importBoard({ factions: [], regions: [{ name: '空城' }] }, { scaleTemplate: 'street' }), /缺少势力或地区/);
    assert.throws(() => importBoard({ factions: [{ name: '孤家' }], regions: [] }, { scaleTemplate: 'street' }), /缺少势力或地区/);
});

test('serialization round trip preserves campaign content', () => {
    const campaign = createCampaign({ scaleTemplate: 'court', name: '朝局' });
    const faction = createFaction(campaign, { name: '首辅', ideologies: [{ name: '清流', weight: 55 }] });
    campaign.factions.push(faction);
    campaign.regions.push(createRegion(campaign, { name: '六部', controller: faction.id }));
    const restored = normalizeCampaign(JSON.parse(JSON.stringify(campaign)));
    assert.equal(restored.name, campaign.name);
    assert.equal(restored.factions[0].id, faction.id);
    assert.equal(restored.regions[0].controller, faction.id);
    assert.deepEqual(restored.factions[0].ideologies, faction.ideologies);
});

test('campaignDigest speaks names, not internal ids', () => {
    const campaign = createCampaign({ scaleTemplate: 'street', name: '街区' });
    const a = createFaction(campaign, { name: '斧头帮' }), b = createFaction(campaign, { name: '码头会' });
    campaign.factions.push(a, b);
    campaign.regions.push(createRegion(campaign, { name: '旧码头', controller: a }));
    const digest = JSON.stringify(campaignDigest(campaign));
    assert.ok(digest.includes('斧头帮') && digest.includes('旧码头'));
    assert.ok(!digest.includes(a.id), '不泄漏内部 id');
    assert.ok(digest.includes('人手=50'));
    assert.ok(defaultMetrics('interstate').every(m => m.max === 100));
});
