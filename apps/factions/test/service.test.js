import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactions, emptyStore } from '../service.js';
import { createCampaign, createFaction, createRegion } from '../model.js';

function harness({ chatId = 'chat-a', avatar = 'hero.png', follow = false } = {}) {
    const data = new Map();
    const storage = { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
    const state = { chatId, avatar, chat: [], prompt: '' };
    const ctx = {
        groupId: null, characterId: 0, characters: [{ avatar: state.avatar }],
        getCurrentChatId: () => state.chatId,
        setExtensionPrompt: (key, text) => { if (text) state.prompt = text; else state.prompt = ''; },
        eventTypes: {}, eventSource: null, chat: state.chat,
    };
    const service = createFactions({ storage, getContext: () => ctx });
    return { service, data, state, ctx, storage };
}

function sandbox(name = '测试棋局') {
    const campaign = createCampaign({ scaleTemplate: 'street', name });
    const a = createFaction(campaign, { name: '甲' }), b = createFaction(campaign, { name: '乙' });
    campaign.factions.push(a, b);
    campaign.regions.push(createRegion(campaign, { name: '东城', controller: a.id, population: 500 }));
    return campaign;
}

test('campaigns live under per-chat storage namespaces', () => {
    const a = harness({ chatId: 'chat-a' });
    const b = harness({ chatId: 'chat-b' });
    a.service.saveCampaign(sandbox('甲的棋局'));
    assert.equal(a.service.active().name, '甲的棋局');
    assert.equal(b.service.active(), null, '另一个聊天读不到');
    assert.equal(b.service.snapshot().names.length, 0);
    assert.ok([...a.data.keys()][0].startsWith('amin_os_factions_v1:'));
    assert.ok([...a.data.keys()][0].includes('chat-a'));
});

test('multiple campaigns switch and delete inside one chat', () => {
    const { service } = harness();
    const first = service.saveCampaign(sandbox('第一局'));
    const second = service.saveCampaign(sandbox('第二局'));
    assert.equal(service.active().id, second.id);
    service.setActive(first.id);
    assert.equal(service.active().name, '第一局');
    service.deleteCampaign(first.id);
    assert.equal(service.active().id, second.id);
    assert.throws(() => service.setActive(first.id), /棋局不存在/);
});

test('scanning a reply parks a pending change without writing storage', () => {
    const { service, data } = harness();
    const saved = service.saveCampaign(sandbox());
    const raw = JSON.parse(data.get([...data.keys()][0]));
    const populationBefore = saved.regions[0].population;
    const pending = service.scanMessage('剧情正文。\n[FACTION_UPDATE]\n{"note":"夜袭","transfers":[{"region":"东城","to":"乙","intensity":"medium","battleType":"field"}]}\n[/FACTION_UPDATE]');
    assert.ok(pending, '识别出待确认变更');
    assert.equal(service.active().regions[0].controller, saved.factions[0].id, '未确认不落盘');
    assert.equal(JSON.parse(data.get([...data.keys()][0])).campaigns[0].regions[0].population, populationBefore, '存储保持原值');
    const preview = service.previewPending();
    assert.equal(preview.events[0].type, 'transfer');
    assert.equal(preview.campaign.regions[0].controller, saved.factions[1].id, '试算给出结算后结果');
    const result = service.confirmPending();
    assert.equal(result.campaign.regions[0].controller, saved.factions[1].id);
    assert.equal(service.pending(), null);
    assert.equal(service.active().regions[0].controller, saved.factions[1].id, '确认后写入');
});

test('broken or irrelevant replies never create pending state', () => {
    const { service } = harness();
    service.saveCampaign(sandbox());
    assert.equal(service.scanMessage('普通回复'), null);
    assert.equal(service.scanMessage('[FACTION_UPDATE]{oops[/FACTION_UPDATE]'), null);
    assert.equal(service.scanMessage('[FACTION_UPDATE]{"note":"空块"}[/FACTION_UPDATE]'), null);
    assert.equal(service.scanMessage(42), null);
    assert.equal(service.pending(), null);
    service.dropPending();
    assert.equal(service.pending(), null);
});

test('corrupt storage falls back to an empty store instead of crashing', () => {
    const { service, data } = harness();
    data.set('amin_os_factions_v1:|hero.png|chat-a', '{broken json');
    service.reset();
    assert.deepEqual(service.snapshot().names, []);
    service.saveCampaign(sandbox('重建棋局'));
    assert.equal(service.active().name, '重建棋局');
    data.set('amin_os_factions_v1:|hero.png|chat-a', JSON.stringify({ version: 9, campaigns: [] }));
    service.reset();
    assert.deepEqual(service.snapshot(), { names: [], activeId: '', follow: false }, '版本不兼容回到空白');
});

test('emptyStore shape stays version one', () => {
    assert.deepEqual(Object.keys(emptyStore()), ['version', 'campaigns', 'activeId', 'follow']);
    assert.equal(emptyStore().version, 1);
});
