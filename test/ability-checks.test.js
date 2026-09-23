import test from 'node:test';
import assert from 'node:assert/strict';
import { createAbilityCheckService, buildCheckConfig } from '../apps/effects/checks.js';
import { mountCheckView } from '../apps/effects/check-view.js';
import { createDiceService, HISTORY_KEY } from '../apps/dice/service.js';
import { createEffects } from '../apps/effects/service.js';
import { KEY as EFFECTS_KEY, activeEffects, restoreEffects, snapshotEffects } from '../apps/effects/model.js';
import { LIBRARY_KEY, emptyLibrary } from '../apps/effects/library.js';
import { KEY as CHARACTERS_KEY, appendSnapshot, emptyStore, resolveStat } from '../apps/characters/model.js';
import { KEY as SCENE_KEY, emptyState } from '../apps/scene/model.js';

function fixture() {
    let randomCalls = 0, ids = 0, saves = 0;
    const skill = { id: 'focus', name: '专注', book: '自建', entryId: '1', original: '选择目标并专注', reminder: '按确认的目标与范围生效', ui: {} };
    const ctx = { chatId: 'a', characterId: 0, getCurrentChatId() { return this.chatId; }, chat: [{ name: '玩家', is_user: true, mes: '准备行动', swipe_id: 0 }],
        chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 意志: 16, 调查: 60 } } }) } }, extensionSettings: { [LIBRARY_KEY]: { ...emptyLibrary(), skills: [skill] } },
        async saveMetadata() { saves++; }, async saveSettingsDebounced() {}, };
    const character = { id: 'hero', name: '调查员', kind: 'pc', notes: '', stats: [
        { id: 'will', label: '意志', binding: '主角.意志', component: 'value', check: 'd20' },
        { id: 'investigate', label: '调查', binding: '主角.调查', component: 'value', check: 'coc' },
    ] };
    ctx.chatMetadata[CHARACTERS_KEY] = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters: [character] }, { id: 'initial', at: '2026-09-23T00:00:00Z' });
    const dice = createDiceService(() => ctx, { rng: () => { randomCalls++; return 10; }, createId: () => `fixed-${++ids}`, now: () => 123 });
    const effects = createEffects(() => ctx), api = createAbilityCheckService(() => ctx, { dice, effects });
    const selection = { skillId: 'focus', holder: '自由文本使用者', targetMode: 'targeted', target: '同伴', scope: '注意力', command: '保持警戒', condition: '直到主动解除', durationMinutes: null };
    const options = { characterId: 'hero', statId: 'will', mode: 'd20', valueMode: 'score', modifier: 2, dc: 12 };
    return { ctx, dice, effects, api, selection, options, randomCalls: () => randomCalls, saves: () => saves,
        stage() { return api.stage(selection, options); },
        dispose() { api.dispose(); effects.dispose(); dice.dispose(); } };
}
const draft = (value = '') => ({ value, dispatchEvent() {}, focus() {} });
function setValue(h, field, value) { const state = JSON.parse(h.ctx.chatMetadata.variables.状态栏); state.项目.主角[field] = value; h.ctx.chatMetadata.variables.状态栏 = JSON.stringify(state); }

test('bound D20 values require explicit score conversion; CoC uses current skill and selected difficulty', () => {
    const h = fixture(), bound = resolveStat(h.ctx, 'hero', 'will'), skill = h.ctx.extensionSettings[LIBRARY_KEY].skills[0];
    assert.equal(buildCheckConfig(bound, skill, { mode: 'd20', valueMode: 'score', modifier: 2 }).modifier, 5);
    assert.equal(buildCheckConfig(bound, skill, { mode: 'd20', valueMode: 'modifier', modifier: -2 }).modifier, 14);
    const coc = buildCheckConfig(resolveStat(h.ctx, 'hero', 'investigate'), skill, { mode: 'coc', modifier: 5, difficulty: 'hard', bonus: 1 });
    assert.equal(coc.skill, 65); assert.equal(coc.difficulty, 'hard'); assert.equal(coc.bonus, 1);
    assert.throws(() => buildCheckConfig(bound, skill, { mode: 'd20', modifier: 0.5 }), /整数/);
    h.dispose();
});
test('ability flow previews actual bound value, fixes one local result, appends only explicitly and applies effect separately', async () => {
    const h = fixture(), beforeStatus = h.ctx.chatMetadata.variables.状态栏, beforeChat = structuredClone(h.ctx.chat);
    const preview = h.stage(); assert.equal(preview.value, 16); assert.equal(preview.selection.holder, '调查员');
    assert.equal(h.randomCalls(), 0); assert.equal(h.saves(), 0); assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined);
    const result = await h.api.roll(); assert.equal(result.results[0].total, 15); assert.equal(h.randomCalls(), 1);
    assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined); assert.equal(h.ctx.chatMetadata.variables.状态栏, beforeStatus);
    const input = draft('我让同伴保持警戒。'); await h.api.append(input);
    assert.ok(input.value.endsWith(result.text)); assert.deepEqual(h.ctx.chat, beforeChat);
    await h.api.apply(); const effects = activeEffects(h.effects.read(), h.ctx.chat);
    assert.equal(effects.length, 1); assert.equal(effects[0].holder, '调查员'); assert.equal(effects[0].target, '同伴'); assert.equal(effects[0].actionId, `ability-check:${result.id}`);
    assert.equal(h.ctx.chatMetadata.variables.状态栏, beforeStatus); assert.deepEqual(h.ctx.chat, beforeChat);
    await assert.rejects(h.api.apply(), /已经确认/); await assert.rejects(h.api.roll(), /已固定/); assert.equal(h.randomCalls(), 1); h.dispose();
});
test('changed actor, stat, ability, candidate or message refuses stale preview before consuming randomness', async () => {
    const mutations = [
        h => setValue(h, '意志', 18),
        h => { h.ctx.chatMetadata[CHARACTERS_KEY].events[0].snapshot.characters[0].name = '改名'; },
        h => { h.ctx.extensionSettings[LIBRARY_KEY].skills[0].reminder = '不同规则'; },
        h => { h.ctx.chat[0].swipe_id = 1; },
        h => { h.ctx.chat.push({ name: '旁白', is_user: false, mes: '另一个场景' }); },
    ];
    for (const mutate of mutations) { const h = fixture(); h.stage(); mutate(h); await assert.rejects(h.api.roll(), /变化/); assert.equal(h.randomCalls(), 0); assert.equal(h.api.preview().stale, true); h.dispose(); }
});
test('a fixed roll is retained on save failure and retry does not consume more random values', async () => {
    const h = fixture(); h.stage(); h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(h.api.roll(), /保存失败/); const fixed = h.api.preview().record;
    assert.ok(fixed?.id); assert.equal(h.api.preview().dirty, true); assert.equal(h.randomCalls(), 1);
    await assert.rejects(h.api.roll(), /已固定/); await assert.rejects(h.api.apply(), /尚未保存/);
    h.ctx.saveMetadata = async () => {}; await h.api.retrySave(); assert.equal(h.randomCalls(), 1);
    const input = draft('正文'); await h.api.append(input); assert.ok(input.value.endsWith(fixed.text)); assert.equal(h.api.preview().dirty, false); h.dispose();
});
test('editing a draft during save retry preserves manual content and stops automatic append', async () => {
    const h = fixture(); h.stage(); h.ctx.saveMetadata = async () => { throw Error('offline'); }; await assert.rejects(h.api.roll());
    let release; h.ctx.saveMetadata = () => new Promise(resolve => { release = resolve; }); const input = draft('初稿');
    const pending = h.api.append(input); input.value = '改好的正文'; release(); await assert.rejects(pending, /草稿已改变/);
    assert.equal(input.value, '改好的正文'); assert.equal(h.randomCalls(), 1); h.dispose();
});
test('effect save failure retains one consumed action and retry saves without reapplying it', async () => {
    const h = fixture(); h.stage(); await h.api.roll(); h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(h.api.apply(), /保存失败/); assert.equal(h.api.preview().applied, true); assert.equal(h.api.preview().effectDirty, true);
    assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 1); await assert.rejects(h.api.apply(), /已经确认/);
    h.ctx.saveMetadata = async () => {}; await h.api.retrySave(); assert.equal(h.api.preview().effectDirty, false);
    assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 1); assert.equal(h.randomCalls(), 1); h.dispose();
});
test('restoring a pre-action snapshot permits a new explicit effect from the same fixed roll without duplicating live effects', async () => {
    const h = fixture(); h.stage(); const fixed = await h.api.roll();
    const beforeAction = snapshotEffects(h.effects.read(), h.ctx.chat);
    await h.api.apply(); assert.equal(h.api.preview().applied, true);
    const original = activeEffects(h.effects.read(), h.ctx.chat)[0];
    await h.effects.mutate(h.effects.capture(), 'end', { id: original.id, reason: '主动解除' });
    assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 0);
    await assert.rejects(h.api.apply(), /已经确认/);
    h.ctx.chatMetadata[EFFECTS_KEY] = restoreEffects(h.effects.read(), h.ctx.chat, beforeAction, { operationId: 'restore-before-action' });
    assert.equal(h.api.preview().applied, false); assert.equal(h.api.preview().record.id, fixed.id);
    await h.api.apply(); const live = activeEffects(h.effects.read(), h.ctx.chat);
    assert.equal(live.length, 1); assert.notEqual(live[0].id, original.id); assert.equal(live[0].actionId, `ability-check:${fixed.id}`);
    assert.equal(h.randomCalls(), 1); assert.equal(h.dice.history().length, 1);
    await assert.rejects(h.api.apply(), /已经确认/); assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 1); h.dispose();
});
test('restored consumed action IDs block check reuse even when no live effect or historical create remains', async () => {
    const h = fixture(); h.stage(); const fixed = await h.api.roll();
    const snapshot = snapshotEffects(h.effects.read(), h.ctx.chat); snapshot.consumedActionIds = [`ability-check:${fixed.id}`];
    h.ctx.chatMetadata[EFFECTS_KEY] = restoreEffects(h.effects.read(), h.ctx.chat, snapshot, { operationId: 'restore-consumed-action' });
    assert.equal(h.api.preview().applied, true); await assert.rejects(h.api.apply(), /已经确认/);
    assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 0); assert.equal(h.randomCalls(), 1); h.dispose();
});
test('changed bindings or replaced fixed history prevent append and effects after a roll', async () => {
    for (const mutate of [h => setValue(h, '意志', 20), h => { h.ctx.chatMetadata[HISTORY_KEY].rolls[0].results[0].total = 100; }, h => { h.ctx.chatMetadata[HISTORY_KEY].rolls = []; }]) {
        const h = fixture(); h.stage(); await h.api.roll(); mutate(h); const input = draft('原文');
        await assert.rejects(h.api.append(input), /变化|不存在/); await assert.rejects(h.api.apply(), /变化|不存在/);
        assert.equal(input.value, '原文'); assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined); h.dispose();
    }
});
test('direct activation stays without target and timed effects require unchanged game clock', async () => {
    const h = fixture(); h.selection.targetMode = 'direct'; h.selection.durationMinutes = 30;
    assert.throws(() => h.stage(), /设置游戏时间/);
    const snapshot = { ...emptyState(), clock: { year: 2030, month: 1, day: 1, hour: 12, minute: 0, calendarLabel: '' } };
    h.ctx.chatMetadata[SCENE_KEY] = { version: 1, events: [{ path: [], snapshot }] };
    const preview = h.stage(); assert.equal(preview.selection.target, ''); await h.api.roll();
    h.ctx.chatMetadata[SCENE_KEY].events[0].snapshot.clock.minute = 5;
    await assert.rejects(h.api.apply(), /游戏时间已变化/); assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined);
    h.stage(); await h.api.roll(); await h.api.apply(); const effect = activeEffects(h.effects.read(), h.ctx.chat)[0];
    assert.equal(effect.targetMode, 'direct'); assert.equal(effect.target, ''); assert.ok(effect.timing); h.dispose();
});
test('switching chat while a fixed roll is saving never reports it as the new chat check', async () => {
    const h = fixture(); h.stage(); const oldMeta = h.ctx.chatMetadata;
    let release; h.ctx.saveMetadata = () => new Promise(resolve => { release = resolve; }); const pending = h.api.roll();
    h.ctx.chatId = 'b'; h.ctx.chatMetadata = {}; h.ctx.chat = []; release();
    await assert.rejects(pending, /聊天已变化|聊天、楼层/); assert.equal(oldMeta[HISTORY_KEY].rolls.length, 1); assert.equal(h.api.preview().stale, true);
    assert.equal(h.ctx.chatMetadata[HISTORY_KEY], undefined); h.dispose();
});

class Element {
    constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label) => walk(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
async function click(root, label) { const button = find(root, label); assert.ok(button, `missing ${label}`); assert.equal(button.disabled, false, `disabled ${label}`); await button.onclick(); }
function uiFixture() {
    const h = fixture(), input = draft('我的行动。'); let invalid = false;
    const doc = { createElement: tag => new Element(tag, doc), querySelector: selector => selector === '#send_textarea' ? input : null };
    const root = doc.createElement('div'); h.selection.holder = '调查员';
    const view = mountCheckView(root, { service: h.api, getSelection: () => { if (invalid) throw Error('持续时长无效，请填写整数'); return h.selection; } });
    return { ...h, root, input, view, invalidate: () => { invalid = true; }, close() { view.dispose(); h.dispose(); } };
}
test('check view exposes preview then roll, draft append and separately consented consequence', async () => {
    const h = uiFixture();
    await click(h.root, '预览检定'); assert.match(h.root.textContent, /意志：16/); assert.equal(h.randomCalls(), 0);
    await click(h.root, '确认本地掷骰'); assert.equal(h.randomCalls(), 1); assert.equal(h.input.value, '我的行动。');
    assert.equal(find(h.root, '确认检定后的效果').disabled, true); assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined);
    await click(h.root, '追加固定结果到草稿'); assert.match(h.input.value, /【骰子/);
    const consent = walk(h.root).find(node => node.tagName === 'INPUT' && node.type === 'checkbox'); consent.checked = true; consent.onchange();
    await click(h.root, '确认检定后的效果'); assert.equal(activeEffects(h.effects.read(), h.ctx.chat).length, 1);
    assert.match(h.root.textContent, /已确认过效果/); h.close(); assert.equal(h.root.children.length, 0);
});
test('invalid duration input invalidates existing view preview instead of leaving prior consequence active', async () => {
    const h = uiFixture(); await click(h.root, '预览检定'); await click(h.root, '确认本地掷骰');
    h.invalidate(); assert.doesNotThrow(() => h.view.refresh()); assert.equal(h.api.preview().stale, true); assert.match(h.root.textContent, /持续时长无效/);
    assert.equal(find(h.root, '追加固定结果到草稿').disabled, true);
    const consent = walk(h.root).find(node => node.tagName === 'INPUT' && node.type === 'checkbox'); consent.checked = true; consent.onchange();
    assert.equal(find(h.root, '确认检定后的效果').disabled, true); assert.equal(h.ctx.chatMetadata[EFFECTS_KEY], undefined); h.close();
});
