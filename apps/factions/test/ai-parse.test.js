import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUpdateBlock, looseJson, parseUpdate, followProtocol, parseReview, proposalsToUpdate, parseBoard, chatExcerpt } from '../ai.js';
import { createCampaign, createFaction, createRegion } from '../model.js';

test('extractUpdateBlock takes the first hidden block and tolerates missing close tag', () => {
    const reply = '正文一笔带过。\n[FACTION_UPDATE]\n{"note":"码头易主"}\n[/FACTION_UPDATE]\n后缀闲话';
    assert.equal(extractUpdateBlock(reply), '{"note":"码头易主"}');
    assert.equal(extractUpdateBlock('没有块的普通回复'), null);
    assert.equal(extractUpdateBlock('[FACTION_UPDATE]\n{"a":1}'), '{"a":1}', '未闭合时取到结尾');
    assert.equal(extractUpdateBlock(null), null, '空输入不崩溃');
});

test('looseJson strips fences and surrounding chatter', () => {
    assert.deepEqual(looseJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(looseJson('前言 {"a":1} 后记'), { a: 1 });
    assert.equal(looseJson('完全不是 JSON'), null);
    assert.equal(looseJson('[1,2,3]'), null, '数组不是对象');
    assert.deepEqual(looseJson('{"a":1}{'), { a: 1 }, '截取最外层可解析对象');
});

test('parseUpdate accepts valid blocks and falls back safely', () => {
    const ok = parseUpdate('[FACTION_UPDATE]\n{"note":"火并","transfers":[{"region":"码头","to":"斧头帮","intensity":"severe","battleType":"skirmish"}],"conditionDelta":[{"region":"码头","delta":-20}],"metricDelta":[{"faction":"斧头帮","key":"现金","delta":-10}],"relationDelta":[{"a":"斧头帮","b":"码头会","delta":-30}]}\n[/FACTION_UPDATE]');
    assert.equal(ok.reason, null);
    assert.equal(ok.update.transfers[0].to, '斧头帮');
    assert.equal(ok.update.transfers[0].battleType, 'skirmish');
    assert.deepEqual(ok.update.populationDelta, []);
    assert.equal(parseUpdate('平平无奇的回复').reason, 'absent');
    assert.equal(parseUpdate('[FACTION_UPDATE]\n{broken json[/FACTION_UPDATE]').reason, 'invalid');
    assert.equal(parseUpdate('[FACTION_UPDATE]\n{"note":"只有说明没有条目"}\n[/FACTION_UPDATE]').reason, 'empty');
    assert.equal(parseUpdate('[FACTION_UPDATE]\nnull\n[/FACTION_UPDATE]').reason, 'invalid');
});

test('parseUpdate drops malformed entries but keeps usable ones', () => {
    const { update, reason } = parseUpdate('[FACTION_UPDATE]\n{"transfers":[{"region":"码头","to":"斧头帮"},{"region":"","to":"谁"},{"to":"斧头帮"}],"metricDelta":[{"faction":"斧头帮","key":"现金","delta":"abc"},{"faction":"斧头帮","key":"现金","delta":5}],"populationDelta":[{"region":"码头","intensity":"nonsense"}]}\n[/FACTION_UPDATE]');
    assert.equal(reason, null);
    assert.equal(update.transfers.length, 1, '缺字段的易主条目被丢弃');
    assert.equal(update.metricDelta.length, 1, '非数字 delta 被丢弃');
    assert.equal(update.populationDelta.length, 1);
    assert.equal(update.populationDelta[0].intensity, 'medium', '非法烈度回退中档');
});

test('followProtocol embeds the protocol and current sandbox names', () => {
    const campaign = createCampaign({ scaleTemplate: 'street', name: '街区' });
    const a = createFaction(campaign, { name: '斧头帮' });
    campaign.factions.push(a);
    campaign.regions.push(createRegion(campaign, { name: '旧码头', controller: a.id }));
    const text = followProtocol(campaign);
    assert.ok(text.includes('[FACTION_UPDATE]') && text.includes('[/FACTION_UPDATE]'));
    assert.ok(text.includes('斧头帮') && text.includes('旧码头'));
    assert.ok(!text.includes(a.id), '不泄漏内部 id');
});

test('parseReview keeps only well-formed proposals', () => {
    const { summary, proposals, reason } = parseReview('```json\n{"summary":"局势升级","proposals":[{"kind":"transfer","region":"旧码头","to":"斧头帮","intensity":"medium","battleType":"field","reason":"火并"},{"kind":"metric","faction":"斧头帮","key":"现金","delta":-15},{"kind":"metric","faction":"斧头帮","delta":-1},{"kind":"condition","region":"旧码头"},{"kind":"coup"}]}\n```');
    assert.equal(reason, null);
    assert.equal(summary, '局势升级');
    assert.equal(proposals.length, 2, '缺字段与非法定义的提案被丢弃，存在性由结算层裁决');
    assert.equal(proposals[0].kind, 'transfer');
    assert.equal(proposals[1].delta, -15);
    assert.equal(parseReview('AI 忽略了格式要求').reason, 'invalid');
    assert.equal(parseReview('{"summary":"x","proposals":[]}').reason, 'empty');
    assert.equal(parseReview('{"summary":"x","proposals":[{"kind":"note","reason":"闲话"}]}').reason, 'empty');
});

test('proposalsToUpdate maps every kind into one update payload', () => {
    const update = proposalsToUpdate([
        { kind: 'transfer', region: '旧码头', to: '斧头帮', intensity: 'severe', battleType: 'siege', reason: '围攻' },
        { kind: 'population', region: '旧码头', intensity: 'light', battleType: 'skirmish' },
        { kind: 'condition', region: '旧码头', delta: -10 },
        { kind: 'metric', faction: '斧头帮', key: '现金', delta: 5 },
        { kind: 'relation', a: '斧头帮', b: '码头会', delta: -20 },
        { kind: 'unknown' },
    ]);
    assert.equal(update.transfers.length, 1);
    assert.equal(update.transfers[0].note, '围攻');
    assert.equal(update.populationDelta.length, 1);
    assert.equal(update.conditionDelta.length, 1);
    assert.equal(update.metricDelta.length, 1);
    assert.equal(update.relationDelta.length, 1);
});

test('parseBoard normalizes a full board and rejects broken ones', () => {
    const good = parseBoard('{"name":"AI 棋局","factions":[{"name":"红帮","metrics":{"人手":70}},{"name":"蓝会"}],"regions":[{"name":"码头","controller":"红帮","population":200},{"name":"市场","controller":"蓝会"}]}', { scaleTemplate: 'street' });
    assert.equal(good.reason, null);
    assert.equal(good.campaign.factions.length, 2);
    assert.equal(good.campaign.factions[0].metrics.find(m => m.key === 'manpower').value, 70);
    assert.equal(good.campaign.regions[0].controller, good.campaign.factions[0].id);
    assert.equal(parseBoard(' совсем не JSON').reason.includes('JSON'), true);
    assert.equal(parseBoard('{"factions":[],"regions":[]}').reason.includes('缺少'), true);
    assert.equal(parseBoard('{"factions":[{"name":"孤家"}],"regions":[]}').reason.includes('缺少'), true);
});

test('chatExcerpt keeps the latest messages and skips system noise', () => {
    const chat = [];
    for (let i = 0; i < 24; i++) chat.push({ name: '角色' + i, is_user: i % 2 === 0, mes: '第' + i + '楼' });
    chat.push({ name: '系统', is_system: true, mes: '隐藏噪音' });
    const excerpt = chatExcerpt({ chat }, 16);
    assert.equal(excerpt.length, 16);
    assert.equal(excerpt.at(-1).text, '第23楼');
    assert.ok(excerpt.every(m => !m.text.includes('噪音')));
    assert.deepEqual(chatExcerpt({}), []);
});

test('parseUpdate passes through cause and neutral event types', () => {
    const { update, reason } = parseUpdate('[FACTION_UPDATE]\n{"note":"联盟谈判","transfers":[{"region":"码头","to":"商会","cause":"purchase"}],"populationDelta":[{"region":"码头","type":"migration","ratio":-0.2}],"conditionDelta":[{"region":"码头","type":"disaster","delta":-30}],"metricDelta":[{"faction":"商会","key":"现金","type":"development","delta":10}]}\n[/FACTION_UPDATE]');
    assert.equal(reason, null);
    assert.equal(update.transfers[0].cause, 'purchase');
    assert.equal(update.populationDelta[0].type, 'migration');
    assert.equal(update.conditionDelta[0].type, 'disaster');
    assert.equal(update.metricDelta[0].type, 'development');
    const legacy = parseUpdate('[FACTION_UPDATE]\n{"transfers":[{"region":"码头","to":"商会"}]}\n[/FACTION_UPDATE]');
    assert.equal(legacy.update.transfers[0].cause, undefined, '未给 cause 不硬填，由规则层兼容判定');
    const bad = parseUpdate('[FACTION_UPDATE]\n{"transfers":[{"region":"码头","to":"商会","cause":"魔法"}]}\n[/FACTION_UPDATE]');
    assert.equal(bad.update.transfers[0].cause, undefined, '非法 cause 丢弃');
});

test('followProtocol and review prompts speak general dynamics, not only war', () => {
    const campaign = createCampaign({ scaleTemplate: 'interstate' });
    campaign.factions.push(createFaction(campaign, { name: '北朝' }));
    campaign.regions.push(createRegion(campaign, { name: '北省', controller: campaign.factions[0].id }));
    const protocol = followProtocol(campaign);
    assert.ok(protocol.includes('purchase|merge|handover'));
    assert.ok(/结盟|交恶|迁徙|灾害/.test(protocol), '提到非战争演变');
    assert.ok(protocol.includes('北朝'));
});

test('parseReview proposals carry cause and type through to updates', () => {
    const { proposals, reason } = parseReview('{"summary":"谈判年","proposals":[{"kind":"transfer","region":"北省","to":"北朝","cause":"handover","reason":"和约移交"},{"kind":"metric","faction":"北朝","key":"manpower","type":"diplomacy","delta":5}]}');
    assert.equal(reason, null);
    const update = proposalsToUpdate(proposals);
    assert.equal(update.transfers[0].cause, 'handover');
    assert.equal(update.transfers[0].note, '和约移交');
    assert.equal(update.metricDelta[0].type, 'diplomacy');
});
