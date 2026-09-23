import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/characters/view.js';
import { createCharactersService } from '../apps/characters/service.js';
import { KEY, emptyStore, appendSnapshot, readCharacters } from '../apps/characters/model.js';
import { createDiceService, HISTORY_KEY } from '../apps/dice/service.js';

class Element {
    constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    dispatchEvent(event) { for (const callback of [...(this.listeners.get(event.type) ?? [])]) callback(event); return true; }
    focus() { this.ownerDocument.activeElement = this; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = element => !element.hidden && (!element.parent || visible(element.parent));
const find = (root, label, tag = 'button') => walk(root).find(element => visible(element) && element.tagName === tag.toUpperCase() && (element.textContent === label || element.getAttribute('aria-label') === label));
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); };
function fire(element, type = 'input') { element.dispatchEvent({ type, target: element, preventDefault() {} }); }
async function click(root, label) { const node = find(root, label); assert.ok(node, `missing button: ${label}`); if (!node.disabled) fire(node, 'click'); await settle(); return node; }
function input(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, `missing field: ${label}`); node.value = String(value); fire(node, tag === 'select' ? 'change' : 'input'); return node; }
const notice = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;
const person = () => ({ id: 'hero', name: '调查员', kind: 'pc', notes: '港口来客', stats: [
    { id: 'strength', label: '力量修正', binding: '调查员.力量修正', component: 'value', check: 'd20' },
    { id: 'listen', label: '聆听', binding: '调查员.聆听', component: 'value', check: 'coc' },
    { id: 'hp', label: '生命', binding: '调查员.生命', component: 'current', check: 'none' },
] });
function fixture({ empty = false } = {}) {
    const handlers = new Map(); let fail = false, saveCount = 0, draws = 0, id = 0;
    const eventSource = { on(type, callback) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(callback); }, removeListener(type, callback) { handlers.get(type)?.delete(callback); }, emit(type) { for (const callback of [...(handlers.get(type) ?? [])]) callback(); } };
    let ctx = { characterId: 1, getCurrentChatId: () => 'chat-a', chatMetadata: { unrelated: { preserved: true }, variables: { other: 'keep', 状态栏: JSON.stringify({ 版本: 1, 项目: { 调查员: { 力量修正: 3, 聆听: 67, 生命: { 当前: 8, 最大: 12 } } } }) } },
        chat: [{ name: '调查员', is_user: true, mes: '我到达码头。' }], extensionSettings: {},
        saveMetadata: async () => { saveCount++; if (fail) throw Error('磁盘离线'); }, eventSource, eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_UPDATED: 'updated' } };
    if (!empty) ctx.chatMetadata[KEY] = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters: [person()] });
    const api = createCharactersService(() => ctx);
    const dice = createDiceService(() => ctx, { createId: () => `fixed-roll-${++id}`, rng: sides => { draws++; return Math.min(10, sides); } });
    const doc = { createElement: tag => new Element(tag, doc), defaultView: { Event }, activeElement: null, querySelector: selector => selector === '#send_textarea' ? draft : null };
    const root = doc.createElement('div'), draft = doc.createElement('textarea'); draft.value = '我观察四周。';
    const options = { service: api, diceService: dice, document: doc }, view = mount(root, options);
    return { root, draft, doc, api, dice, options, view, ctx: () => ctx, fail(value) { fail = value; }, saveCount: () => saveCount, draws: () => draws,
        setWorld(update) { const state = JSON.parse(ctx.chatMetadata.variables.状态栏); update(state); ctx.chatMetadata.variables.状态栏 = JSON.stringify(state); api.sync(); },
        switchChat() { ctx = { ...ctx, chatMetadata: {}, chat: [], getCurrentChatId: () => 'chat-b' }; eventSource.emit('chat'); },
        close() { view.dispose(); api.dispose(); dice.dispose(); } };
}

test('character creation stores PC/NPC data and bindings only after explicit save', async () => {
    const f = fixture({ empty: true });
    await click(f.root, '新增人物卡'); input(f.root, '人物名称', '船长'); input(f.root, '人物类型', 'npc', 'select'); input(f.root, '人物备注', '知道潮汐的老水手', 'textarea');
    await click(f.root, '添加属性或技能'); input(f.root, '属性或技能名称', '侦察'); input(f.root, '世界状态字段', '调查员.聆听', 'select'); input(f.root, '检定方式', 'coc', 'select');
    assert.equal(f.ctx().chatMetadata[KEY], undefined); await click(f.root, '保存人物卡');
    const saved = readCharacters(f.ctx()).characters[0];
    assert.equal(saved.kind, 'npc'); assert.equal(saved.name, '船长'); assert.equal(saved.stats[0].binding, '调查员.聆听'); assert.equal(saved.stats[0].check, 'coc'); assert.equal(Object.hasOwn(saved.stats[0], 'value'), false);
    assert.match(f.root.textContent, /当前值：67/); assert.deepEqual(f.ctx().chatMetadata.unrelated, { preserved: true }); f.close();
});

test('numeric edit previews before commit and rejects an invalid progress value', async () => {
    const f = fixture(); await click(f.root, '修改 生命'); input(f.root, '新的数值', '20'); await click(f.root, '预览数值变更');
    assert.match(notice(f.root), /当前值.*最大值/); assert.equal(JSON.parse(f.ctx().chatMetadata.variables.状态栏).项目.调查员.生命.当前, 8);
    input(f.root, '新的数值', '0'); await click(f.root, '预览数值变更');
    assert.equal(JSON.parse(f.ctx().chatMetadata.variables.状态栏).项目.调查员.生命.当前, 8); assert.match(f.root.textContent, /8 → 0/);
    await click(f.root, '确认更新世界状态'); assert.equal(JSON.parse(f.ctx().chatMetadata.variables.状态栏).项目.调查员.生命.当前, 0); assert.equal(f.ctx().chatMetadata.variables.other, 'keep'); f.close();
});

test('editing a value after preview invalidates the old confirmation', async () => {
    const f = fixture(); await click(f.root, '修改 力量修正'); input(f.root, '新的数值', '5'); await click(f.root, '预览数值变更');
    input(f.root, '新的数值', '9'); assert.equal(find(f.root, '确认更新世界状态').disabled, true); await click(f.root, '确认更新世界状态');
    assert.equal(JSON.parse(f.ctx().chatMetadata.variables.状态栏).项目.调查员.力量修正, 3); await click(f.root, '取消编辑'); f.close();
});

test('D20 reads the current shared modifier and only appends after a separate action', async () => {
    const f = fixture(); f.setWorld(state => { state.项目.调查员.力量修正 = 6; }); await click(f.root, '检定 力量修正');
    input(f.root, '目标 DC（可选）', '15'); input(f.root, '优劣势', 'advantage', 'select'); await click(f.root, '执行本地检定');
    const roll = f.dice.history()[0]; assert.equal(roll.settings.modifier, 6); assert.equal(roll.settings.advantage, 'advantage'); assert.equal(roll.results[0].total, 16); assert.equal(f.draft.value, '我观察四周。');
    await click(f.root, '执行本地检定'); assert.equal(f.dice.history().length, 1); assert.equal(f.draws(), 2);
    await click(f.root, '追加固定结果到草稿'); assert.equal(f.draft.value, `我观察四周。\n${roll.text}`); assert.equal(f.dice.history()[0].status, 'appended'); f.close();
});

test('CoC controls use bound skill with explicit difficulty and bonus/penalty', async () => {
    const f = fixture(); await click(f.root, '检定 聆听'); input(f.root, '检定难度', 'hard', 'select'); input(f.root, '奖励骰', '2', 'select'); input(f.root, '惩罚骰', '1', 'select');
    await click(f.root, '执行本地检定'); const config = f.dice.history()[0].settings;
    assert.equal(config.skill, 67); assert.equal(config.difficulty, 'hard'); assert.equal(config.bonus, 2); assert.equal(config.penalty, 1); assert.equal(f.draft.value, '我观察四周。'); f.close();
});

test('missing bindings show a repair action and disable numeric/check actions', async () => {
    const f = fixture(); f.setWorld(state => { delete state.项目.调查员.力量修正; });
    assert.match(f.root.textContent, /绑定字段不存在：调查员.力量修正/); assert.equal(find(f.root, '检定 力量修正').disabled, true); assert.equal(find(f.root, '修改 力量修正').disabled, true); assert.equal(find(f.root, '编辑人物卡').disabled, false); f.close();
});

test('external updates preserve active input and stale editor cannot overwrite current data', async () => {
    const f = fixture(); await click(f.root, '编辑人物卡'); const name = input(f.root, '人物名称', '尚未保存的人物名'); name.focus();
    f.setWorld(state => { state.项目.调查员.聆听 = 77; });
    assert.equal(find(f.root, '人物名称', 'input'), name); assert.equal(name.value, '尚未保存的人物名'); assert.equal(f.doc.activeElement, name); assert.match(notice(f.root), /编辑内容已保留/);
    await click(f.root, '保存人物卡'); assert.equal(readCharacters(f.ctx()).characters[0].name, '调查员'); assert.equal(name.value, '尚未保存的人物名');
    await click(f.root, '取消编辑'); assert.match(f.root.textContent, /当前值：77/); f.close();
});

test('background value refresh retains a focused search and updates after it loses focus', async () => {
    const f = fixture(), search = input(f.root, '筛选人物', '调查'); search.focus();
    f.setWorld(state => { state.项目.调查员.聆听 = 81; });
    assert.equal(find(f.root, '筛选人物', 'input'), search); assert.equal(search.value, '调查'); assert.equal(f.doc.activeElement, search);
    f.root.focus(); fire(f.root.children[0], 'focusout'); await settle();
    assert.equal(find(f.root, '筛选人物', 'input').value, '调查'); assert.match(f.root.textContent, /当前值：81/); f.close();
});

test('long character and stat names have a bounded editable dice label', async () => {
    const f = fixture(), character = person(); character.name = '调查员'.repeat(40); character.stats[0].label = '力量'.repeat(40);
    await f.api.saveCharacter(character); await click(f.root, `检定 ${character.stats[0].label}`);
    const label = find(f.root, '骰点名称', 'input'); assert.equal(label.value.length, 80); input(f.root, '骰点名称', '撬开舱门');
    await click(f.root, '执行本地检定'); assert.equal(f.dice.history()[0].settings.label, '撬开舱门'); assert.equal(label.disabled, true); f.close();
});

test('chat switch closes old editor and exposes only current-chat characters', async () => {
    const f = fixture(); await click(f.root, '编辑人物卡'); input(f.root, '人物名称', '旧聊天编辑'); const original = f.ctx();
    f.switchChat(); await settle(); assert.equal(find(f.root, '保存人物卡'), undefined); assert.match(f.root.textContent, /chat-b/); assert.equal(f.ctx().chatMetadata[KEY], undefined); assert.equal(readCharacters(original).characters[0].name, '调查员'); f.close();
});

test('save failure preserves inputs and retry persists one committed operation', async () => {
    const f = fixture(); await click(f.root, '编辑人物卡'); const name = input(f.root, '人物名称', '保存中的调查员'); f.fail(true);
    await click(f.root, '保存人物卡'); assert.match(notice(f.root), /磁盘离线/); assert.equal(name.value, '保存中的调查员'); assert.equal(f.ctx().chatMetadata[KEY].events.length, 2); assert.equal(find(f.root, '保存人物卡').disabled, true);
    f.fail(false); await click(f.root, '重试保存已确认的操作'); assert.equal(f.ctx().chatMetadata[KEY].events.length, 2); assert.equal(find(f.root, '保存人物卡'), undefined); assert.match(f.root.textContent, /保存中的调查员/); f.close();
});

test('failed dice persistence keeps the fixed visible roll and retry never rerolls', async () => {
    const f = fixture(); await click(f.root, '检定 力量修正'); f.fail(true); await click(f.root, '执行本地检定');
    const roll = f.ctx().chatMetadata[HISTORY_KEY].rolls[0]; assert.match(f.root.textContent, new RegExp(roll.id.replace(/-/g, '').slice(0, 12))); assert.equal(f.draws(), 1); assert.equal(find(f.root, '执行本地检定').disabled, true);
    f.fail(false); await click(f.root, '重试保存固定骰点'); await click(f.root, '追加固定结果到草稿'); assert.equal(f.draws(), 1); assert.equal(f.dice.history().length, 1); assert.equal(f.draft.value, `我观察四周。\n${roll.text}`); f.close();
});

test('mount/open/dispose are idempotent and a shared service stays usable', () => {
    const f = fixture(); assert.equal(mount(f.root, f.options), f.view); f.view.open(); assert.equal(f.root.children.length, 1);
    f.view.dispose(); f.view.dispose(); assert.equal(f.root.children.length, 0); assert.equal(f.api.read().characters.length, 1);
    const next = mount(f.root, f.options); assert.notEqual(next, f.view); assert.equal(f.root.children.length, 1); next.dispose(); f.close();
});
