import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/journal/view.js';
import { KEY, empty, change, currentEntries, compile, sourceFromRange, exportRecords, currentDrafts } from '../apps/journal/model.js';
import * as Characters from '../apps/characters/model.js';

class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this, preventDefault() {}, ...event }); if (['input', 'change'].includes(type)) this.parent?.dispatch(type, event); }
    focus() {} select() {}
}
const walk = root => [root, ...root.children.flatMap(walk)];
const visible = node => !node.hidden && (!node.parent || visible(node.parent));
const find = (root, label, tag = 'button') => walk(root).find(node => visible(node) && node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
const wait = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); node.dispatch('click'); await wait(); }
function input(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = value; node.dispatch('input'); return node; }
const notice = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;

function fixture() {
    const handlers = new Map(), calls = [], prompts = new Map(); let responder, failSave = false;
    const source = { on(type, callback) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(callback); }, removeListener(type, callback) { handlers.get(type)?.delete(callback); }, emit(type) { for (const callback of [...(handlers.get(type) ?? [])]) callback(); } };
    let ctx = { characterId: 1, getCurrentChatId: () => 'chat-a', chatMetadata: { unrelated: 'keep' }, chat: [{ name: '旅人', is_user: true, mes: '我进入古堡。' }, { name: '向导', is_user: false, mes: '墙上挂着一枚生锈钥匙。' }, { name: '旅人', is_user: true, mes: '我将钥匙放入包中。' }],
        saveMetadata: async () => { if (failSave) throw Error('disk unavailable'); }, setExtensionPrompt: (key, value) => prompts.set(key, value),
        eventTypes: { CHAT_CHANGED: 'chat', MESSAGE_UPDATED: 'updated', GENERATION_AFTER_COMMANDS: 'generate', GENERATION_ENDED: 'end' }, eventSource: source };
    const ai = { capture: app => ({ app, config: { model: 'test' } }), generate: (...args) => { calls.push(args); return new Promise(resolve => { responder = resolve; }); } };
    const doc = { createElement: tag => new Node(tag), defaultView: { navigator: { clipboard: { writeText: async () => {} } } } };
    const root = new Node('div'), options = { document: doc, getContext: () => ctx, ai: () => ai }, view = mount(root, options);
    return { root, view, options, calls, handlers, source, ctx: () => ctx, setFailure: value => { failSave = value; }, switch() { ctx = { ...ctx, chatMetadata: {}, getCurrentChatId: () => 'chat-b', chat: [{ name: '新角色', mes: '另一段故事' }] }; source.emit('chat'); }, async respond(text) { responder(text); await wait(); } };
}

test('journal mount is idempotent and disposal removes own listeners and surface', () => {
    const f = fixture(); assert.equal(mount(f.root, f.options), f.view); assert.equal(f.root.children.length, 1);
    assert.ok([...f.handlers.values()].some(list => list.size)); f.view.dispose(); assert.equal(f.root.children.length, 0);
    assert.ok([...f.handlers.values()].every(list => list.size === 0));
});

test('hook form saves manual details only on Save, and reference remains off until explicit toggle', async () => {
    const f = fixture(); await click(f.root, '新增伏笔'); input(f.root, '标题', '生锈钥匙'); input(f.root, '伏笔内容', '钥匙可能对应地下室的门。', 'textarea'); input(f.root, '关联人物（逗号分隔，可选）', '向导，旅人');
    assert.equal(f.ctx().chatMetadata[KEY], undefined); await click(f.root, '保存伏笔');
    const record = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat)[0]; assert.equal(record.title, '生锈钥匙'); assert.deepEqual(record.actors, ['向导', '旅人']); assert.equal(record.enabled, false); assert.equal(compile(f.ctx().chatMetadata[KEY], f.ctx().chat), '');
    await click(f.root, '启用引用'); assert.match(compile(f.ctx().chatMetadata[KEY], f.ctx().chat), /生锈钥匙/); assert.equal(f.ctx().chatMetadata.unrelated, 'keep'); f.view.dispose();
});

test('AI chronicle previews exact chosen range, then requires adoption and explicit Save', async () => {
    const f = fixture(); await click(f.root, '编年史'); await click(f.root, '新增编年史'); input(f.root, '标题', '古堡调查'); input(f.root, '起始楼层', '2'); input(f.root, '结束楼层', '3');
    await click(f.root, '生成编年史草稿'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][3].snapshot.app, 'journal');
    const request = JSON.parse(f.calls[0][2].prompt); assert.deepEqual(request.所选楼层原文.map(message => message.楼层), [2, 3]); assert.doesNotMatch(f.calls[0][2].prompt, /我进入古堡/);
    await f.respond('向导指出墙上的钥匙，旅人收起了它。');
    assert.equal(f.ctx().chatMetadata[KEY], undefined); assert.equal(find(f.root, '编年史正文', 'textarea').value, '');
    input(f.root, 'AI 草稿（可修改）', '修订：旅人收起生锈的钥匙。', 'textarea'); await click(f.root, '采用草稿到正文'); assert.equal(f.ctx().chatMetadata[KEY], undefined);
    await click(f.root, '保存编年史'); const records = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat); assert.equal(records.length, 1); assert.equal(records[0].body, '修订：旅人收起生锈的钥匙。'); assert.equal(records[0].enabled, false); assert.equal(records[0].sources.start, 1); f.view.dispose();
});

test('typing after an AI request invalidates its late result without replacing manual prose', async () => {
    const f = fixture(); await click(f.root, '编年史'); await click(f.root, '新增编年史'); input(f.root, '标题', '调查');
    await click(f.root, '生成编年史草稿'); input(f.root, '编年史正文', '用户后来写的内容', 'textarea'); await f.respond('较早请求的回复');
    assert.match(notice(f.root), /编辑内容已变化/); assert.equal(find(f.root, '编年史正文', 'textarea').value, '用户后来写的内容'); assert.equal(find(f.root, 'AI 草稿（可修改）', 'textarea'), undefined); assert.equal(f.ctx().chatMetadata[KEY], undefined); f.view.dispose();
});

test('chat switches close editor and discard a previous chat AI result', async () => {
    const f = fixture(); await click(f.root, '编年史'); await click(f.root, '新增编年史'); input(f.root, '标题', '旧聊天'); await click(f.root, '生成编年史草稿');
    const old = f.ctx(); f.switch(); await f.respond('迟到的旧摘要');
    assert.equal(old.chatMetadata[KEY], undefined); assert.equal(f.ctx().chatMetadata[KEY], undefined); assert.equal(find(f.root, 'AI 草稿（可修改）', 'textarea'), undefined); assert.match(f.root.textContent, /chat-b/); f.view.dispose();
});

test('source edits invalidate an open form and preserve its text for copying', async () => {
    const f = fixture(); await click(f.root, '新增伏笔'); input(f.root, '标题', '待保存'); input(f.root, '伏笔内容', '手写内容', 'textarea');
    f.ctx().chat[1].mes = '正文编辑'; f.source.emit('updated'); await click(f.root, '保存伏笔');
    assert.match(notice(f.root), /来源已变化/); assert.equal(find(f.root, '伏笔内容', 'textarea').value, '手写内容'); assert.equal(f.ctx().chatMetadata[KEY], undefined); f.view.dispose();
});

test('save failure keeps the editable form and a retry saves once', async () => {
    const f = fixture(); await click(f.root, '新增伏笔'); input(f.root, '标题', '保存重试'); input(f.root, '伏笔内容', '正文保持', 'textarea'); f.setFailure(true); await click(f.root, '保存伏笔');
    assert.match(notice(f.root), /disk unavailable/); assert.equal(find(f.root, '伏笔内容', 'textarea').value, '正文保持'); assert.equal(f.ctx().chatMetadata[KEY], undefined);
    f.setFailure(false); await click(f.root, '保存伏笔'); assert.equal(f.ctx().chatMetadata[KEY].events.length, 1); f.view.dispose();
});

test('dirty editors block tab navigation until Save or explicit Cancel', async () => {
    const f = fixture(); await click(f.root, '新增伏笔'); input(f.root, '标题', '尚未保存'); await click(f.root, '编年史'); assert.match(notice(f.root), /未保存/); assert.ok(find(f.root, '保存伏笔'));
    await click(f.root, '取消编辑'); await click(f.root, '编年史'); assert.ok(find(f.root, '新增编年史')); assert.equal(f.ctx().chatMetadata[KEY], undefined); f.view.dispose();
});

test('invalid source ranges and unbound enabled references cannot save', async () => {
    const f = fixture(); await click(f.root, '新增伏笔'); input(f.root, '标题', '来源'); input(f.root, '伏笔内容', '正文', 'textarea'); input(f.root, '起始楼层', '99'); await click(f.root, '保存伏笔'); assert.match(notice(f.root), /来源范围/);
    const binding = find(f.root, '绑定当前聊天的来源楼层', 'input'); binding.checked = false; binding.dispatch('change'); const reference = find(f.root, '启用后续生成引用（当前分支）', 'input'); reference.checked = true; reference.dispatch('change');
    await click(f.root, '保存伏笔'); assert.match(notice(f.root), /请先绑定/); assert.equal(f.ctx().chatMetadata[KEY], undefined); f.view.dispose();
});

test('JSON import previews without mutation and saves disabled unbound records once', async () => {
    const f = fixture(), chat = f.ctx().chat;
    const store = change(empty(), chat, 'create', { id: 'exported', kind: 'hook', title: '导入线索', body: '别的聊天里的线索', actors: [], status: 'open', enabled: true, sources: sourceFromRange(chat, 0, 0) });
    await click(f.root, '导入 / 导出'); input(f.root, '粘贴剧情档案 JSON', exportRecords(store, chat), 'textarea'); await click(f.root, '验证并预览导入');
    assert.equal(f.ctx().chatMetadata[KEY], undefined); assert.match(f.root.textContent, /即将导入 1 条/); await click(f.root, '确认保存导入');
    const records = currentEntries(f.ctx().chatMetadata[KEY], chat); assert.equal(records.length, 1); assert.equal(records[0].enabled, false); assert.equal(records[0].sources, null); assert.notEqual(records[0].id, 'exported'); assert.equal(compile(f.ctx().chatMetadata[KEY], chat), ''); f.view.dispose();
});

test('list filtering and status changes retain unrelated records', async () => {
    const f = fixture(), chat = f.ctx().chat;
    let store = empty(); for (const [id, title, actor] of [['a', '钥匙', '向导'], ['b', '足迹', '猎人']]) store = change(store, chat, 'create', { id, title, kind: 'hook', body: '线索', status: 'open', actors: [actor], sources: sourceFromRange(chat, 0, 0) });
    f.ctx().chatMetadata[KEY] = store; f.view.open(); input(f.root, '搜索标题、正文或人物', '向导'); assert.match(f.root.textContent, /钥匙/); assert.doesNotMatch(f.root.textContent, /足迹/);
    await click(f.root, '标为已回收'); const entries = currentEntries(f.ctx().chatMetadata[KEY], chat); assert.equal(entries.find(entry => entry.id === 'a').status, 'resolved'); assert.equal(entries.find(entry => entry.id === 'b').status, 'open'); f.view.dispose();
});

test('fact and memory forms use stable people and retain the fact when a memory is forgotten', async () => {
    const f = fixture();
    f.ctx().chatMetadata[Characters.KEY] = Characters.appendSnapshot(Characters.emptyStore(), [], { version: 1, characters: [{ id: 'guide', name: '向导', kind: 'npc', stats: [], notes: '' }] }, { id: 'seed-people' });
    await click(f.root, '事实与记忆'); await click(f.root, '新增事实'); input(f.root, '事实标题', '钥匙的位置'); input(f.root, '事实内容', '钥匙原来挂在墙上。', 'textarea');
    await click(f.root, '保存事实'); const [fact] = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat); assert.equal(fact.kind, 'fact'); assert.equal(fact.enabled, false);
    await click(f.root, '新增人物记忆'); input(f.root, '人物', 'guide', 'select'); input(f.root, '关联事实', fact.id, 'select'); input(f.root, '认知状态', 'rumor', 'select');
    input(f.root, '人物理解或传闻内容（可选）', '只听说墙上有钥匙。', 'textarea'); input(f.root, '可信程度（0–100）', '30'); input(f.root, '获知时间', '昨天夜里');
    await click(f.root, '保存人物记忆'); let records = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat), memory = records.find(entry => entry.kind === 'knowledge');
    assert.equal(memory.characterId, 'guide'); assert.equal(memory.factId, fact.id); assert.equal(memory.confidence, 30); assert.equal(memory.learnedAtText, '昨天夜里');
    await click(f.root, '标记遗忘'); records = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat); memory = records.find(entry => entry.kind === 'knowledge');
    assert.equal(memory.state, 'forgotten'); assert.equal(records.find(entry => entry.kind === 'fact').body, '钥匙原来挂在墙上。');
    f.view.open({ characterId: 'guide' }); assert.equal(find(f.root, '筛选人物记忆', 'select').value, 'guide'); f.view.dispose();
});

test('automatic draft UI requires settings save, AI completion and explicit confirmation before creating a chronicle', async () => {
    const f = fixture(); await click(f.root, '自动整理');
    const enabled = find(f.root, '启用自动编年史', 'input'); assert.equal(enabled.checked, false); enabled.checked = true; enabled.dispatch('change');
    input(f.root, '每多少楼整理一次', '2'); input(f.root, '从第几楼开始累计', '1'); await click(f.root, '保存自动整理设置');
    assert.equal(f.ctx().chatMetadata[KEY].autoChronicle.enabled, true); await click(f.root, '生成下一段待确认草稿'); assert.equal(f.calls.length, 1);
    await f.respond('旅人抵达古堡，向导指出钥匙。'); assert.equal(currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat).length, 0);
    assert.equal(currentDrafts(f.ctx().chatMetadata[KEY], f.ctx().chat).length, 1); await click(f.root, '审核草稿'); input(f.root, '草稿正文', '审核后：向导指出了墙上的钥匙。', 'textarea');
    await click(f.root, '确认保存编年史'); const [record] = currentEntries(f.ctx().chatMetadata[KEY], f.ctx().chat); assert.equal(record.body, '审核后：向导指出了墙上的钥匙。'); assert.equal(record.enabled, false);
    assert.equal(find(f.root, '审核草稿'), undefined); f.view.dispose();
});

test('prequel import requires selecting entries and explicit source confirmation, then a separate reference choice', async () => {
    const f = fixture(), chat = f.ctx().chat, store = change(empty(), chat, 'create', { id: 'previous-record', kind: 'chronicle', title: '前作结尾', body: '向导离开了古堡。', sources: sourceFromRange(chat, 0, 0) });
    await click(f.root, '前作参考'); input(f.root, '前作名称', '第一卷'); input(f.root, '前作剧情档案 JSON', exportRecords(store, chat), 'textarea');
    await click(f.root, '预览并选择前作条目'); await click(f.root, '确认保存选中的前作条目'); assert.match(notice(f.root), /勾选前作来源确认/); assert.equal(f.ctx().chatMetadata[KEY], undefined);
    const chosen = find(f.root, '选用：前作结尾', 'input'), confirm = find(f.root, '我已核对前作来源，仅选用勾选的条目作为背景', 'input'); chosen.checked = true; chosen.dispatch('change'); confirm.checked = true; confirm.dispatch('change');
    await click(f.root, '确认保存选中的前作条目'); let [prior] = currentEntries(f.ctx().chatMetadata[KEY], chat); assert.equal(prior.kind, 'prior'); assert.equal(prior.enabled, false); assert.equal(prior.sources, null);
    await click(f.root, '核对并设置引用'); const check = find(f.root, '我已核对来源，将这些内容仅作为前作背景参考', 'input'), reference = find(f.root, '启用后续生成引用（当前分支）', 'input');
    check.checked = true; check.dispatch('change'); reference.checked = true; reference.dispatch('change'); await click(f.root, '确认前作引用范围');
    [prior] = currentEntries(f.ctx().chatMetadata[KEY], chat); assert.equal(prior.enabled, true); assert.match(compile(f.ctx().chatMetadata[KEY], chat), /第一卷/); f.view.dispose();
});
