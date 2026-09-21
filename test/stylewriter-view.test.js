import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/stylewriter/view.js';
import { STORE_KEY } from '../apps/stylewriter/model.js';

// ---- Minimal DOM double: only the subset the stylewriter view uses. ----
class FakeEvent { constructor(type, init = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); } }
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.style = {};
        this.listeners = new Map(); this._text = ''; this._className = '';
        this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
        this.type = ''; this.maxLength = NaN; this.rows = 0; this.id = ''; this.dispatched = [];
    }
    get className() { return this._className; }
    set className(value) { this._className = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove?.(); node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { this.dispatched.push(event); for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event); return true; }
    focus() {} select() {}
}

const wait = async (ticks = 3) => { for (let i = 0; i < ticks; i++) await new Promise(resolve => setImmediate(resolve)); };
function* walk(node) { yield node; for (const child of [...node.children]) yield* walk(child); }
const descendants = root => [...walk(root)];
const byText = (root, text, tag = 'button') => descendants(root).find(node => node.tagName === tag.toUpperCase() && node.textContent === text);
const byTextPrefix = (root, prefix, tag = 'button') => descendants(root).find(node => node.tagName === tag.toUpperCase() && node.textContent.startsWith(prefix));
const byLabel = (root, label, tag) => descendants(root).find(node => node.tagName === tag.toUpperCase() && node.attributes['aria-label'] === label);
const statusOf = root => descendants(root).find(node => node.className.includes('amin-notice')).textContent;
const fire = (node, type) => node.dispatchEvent(new FakeEvent(type));
const click = async (root, text) => {
    const button = byText(root, text) || byTextPrefix(root, text);
    if (!button) throw Error('button not found: ' + text);
    button.dispatchEvent(new FakeEvent('click'));
    await wait();
    return button;
};

function fixture(over = {}) {
    const input = new FakeNode('textarea');
    const doc = {
        createElement: tag => new FakeNode(tag),
        querySelector: selector => (selector === '#send_textarea' ? input : null),
        defaultView: { navigator: {} },
    };
    const handlers = new Map();
    const eventSource = {
        on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
        off(type, fn) { handlers.get(type)?.delete(fn); },
        emit(type) { for (const fn of [...(handlers.get(type) ?? [])]) fn(); },
    };
    const ctx = {
        getCurrentChatId: () => 'chat-a',
        characterId: 0, groupId: null, name1: '我', name2: '艾琳',
        characters: [{ avatar: 'a.png', name: '艾琳' }],
        chatMetadata: { note_title: '初见' },
        chat: [
            { name: '艾琳', is_user: false, mes: '风声掠过塔顶。' },
            { name: '我', is_user: true, mes: '我抬头看她。' },
        ],
        extensionSettings: {}, saveSettingsDebounced() {},
        eventTypes: { CHAT_CHANGED: 'chat_changed' }, eventSource,
        ...over,
    };
    const calls = [];
    let responder = null;
    const generate = (currentCtx, request, opts) => new Promise((resolve, reject) => { calls.push({ ctx: currentCtx, request, opts }); responder = { resolve, reject }; });
    const ai = { capture: () => ({ config: { timeoutSeconds: 5 }, channelName: '全局默认', preset: {} }) };
    const target = new FakeNode('div');
    const options = { document: doc, getContext: () => ctx, ai: () => ai, generate };
    const view = mount(target, options);
    const root = descendants(target).find(node => node.id === 'stylewriter-app');
    const respond = async value => { responder?.resolve(value); await wait(); };
    const fail = async error => { responder?.reject(error); await wait(); };
    return { view, options, target, root, input, doc, ctx, eventSource, calls, respond, fail, ai };
}

test('mounting twice binds once; dispose unbinds and a fresh mount works', async () => {
    const f = fixture();
    const again = mount(f.target, f.options);
    assert.equal(again, f.view);
    assert.equal(descendants(f.target).filter(node => node.id === 'stylewriter-app').length, 1);
    assert.equal(descendants(f.target).filter(node => node.tagName === 'BUTTON' && node.textContent === '转换文风').length, 1);
    assert.match(statusOf(f.root), /填写原文/);
    f.view.dispose();
    assert.equal(descendants(f.target).filter(node => node.id === 'stylewriter-app').length, 0);
    const remounted = mount(f.target, f.options);
    assert.notEqual(remounted, f.view);
    assert.equal(descendants(f.target).filter(node => node.id === 'stylewriter-app').length, 1);
});

test('preset CRUD persists to extensionSettings with validation, drafts survive switching, delete confirms and undoes', async () => {
    const f = fixture();
    const select = byLabel(f.root, '文风预设', 'select');
    assert.equal(select.children.length, 2);
    await click(f.root, '新建预设');
    const name = byLabel(f.root, '预设名称', 'input');
    const desc = byLabel(f.root, '文风说明', 'textarea');
    name.value = '冷峻悬疑'; fire(name, 'input');
    desc.value = '多用短句，克制情绪，悬念后置。'; fire(desc, 'input');
    await click(f.root, '保存新预设');
    const saved = f.ctx.extensionSettings[STORE_KEY];
    const created = saved.presets.find(p => p.name === '冷峻悬疑');
    assert.ok(created);
    assert.equal(saved.selectedId, created.id);
    assert.equal(select.children.length, 3);
    assert.match(statusOf(f.root), /已保存/);
    // duplicate names and key-shaped text are rejected
    await click(f.root, '新建预设');
    name.value = '冷峻悬疑'; fire(name, 'input');
    desc.value = 'x'; fire(desc, 'input');
    await click(f.root, '保存新预设');
    assert.match(statusOf(f.root), /同名/);
    name.value = '密钥探测'; fire(name, 'input');
    desc.value = 'api_key=abcd1234efgh5678'; fire(desc, 'input');
    await click(f.root, '保存新预设');
    assert.match(statusOf(f.root), /密钥/);
    await click(f.root, '放弃修改');
    // unsaved edits survive preset switching and are not cleared by other actions
    const firstSeed = saved.presets.find(p => p.name === '简洁明快');
    select.value = firstSeed.id; fire(select, 'change'); await wait();
    name.value = '改名草稿'; fire(name, 'input');
    const secondSeed = f.ctx.extensionSettings[STORE_KEY].presets.find(p => p.name === '细腻古典');
    select.value = secondSeed.id; fire(select, 'change'); await wait();
    assert.equal(name.value, '细腻古典');
    select.value = firstSeed.id; fire(select, 'change'); await wait();
    assert.equal(name.value, '改名草稿');
    // delete needs a second confirming click, then can be undone
    const before = f.ctx.extensionSettings[STORE_KEY].presets.length;
    const armed = await click(f.root, '删除预设');
    assert.match(armed.textContent, /确认删除/);
    assert.equal(f.ctx.extensionSettings[STORE_KEY].presets.length, before);
    await click(f.root, '确认删除「简洁明快」？');
    assert.equal(f.ctx.extensionSettings[STORE_KEY].presets.filter(p => p.name === '简洁明快').length, 0);
    assert.match(statusOf(f.root), /已删除/);
    await click(f.root, '撤销删除');
    assert.ok(f.ctx.extensionSettings[STORE_KEY].presets.some(p => p.name === '简洁明快'));
});

test('custom-mode conversion captures input, fills back via input event only, and blocks edited drafts', async () => {
    const f = fixture();
    await click(f.root, '自定义文风');
    const source = byLabel(f.root, '原文', 'textarea');
    source.value = '原文内容'; fire(source, 'input');
    f.input.value = '输入框草稿';
    await click(f.root, '转换文风');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].request.prompt, /原文内容/);
    assert.ok(!f.calls[0].request.prompt.includes('风声掠过塔顶'), 'custom mode must not read the chat');
    assert.match(statusOf(f.root), /转换中.*自定义文风/);
    assert.ok(f.calls[0].opts.snapshot?.config, 'snapshot captured at request time');
    await f.respond('改写后的内容');
    const result = byLabel(f.root, '转换结果', 'textarea');
    assert.equal(result.value, '改写后的内容');
    assert.match(statusOf(f.root), /完成.*自定义文风/);
    assert.match(descendants(f.root).find(node => node.textContent.startsWith('本次转换：')).textContent, /自定义文风/);
    // fill back writes a draft and dispatches only an input event — never a send/submit
    await click(f.root, '填回聊天输入框');
    assert.equal(f.input.value, '改写后的内容');
    assert.deepEqual(f.input.dispatched.map(event => event.type), ['input']);
    assert.match(statusOf(f.root), /不会自动发送|不会发送/);
    await click(f.root, '撤销填回');
    assert.equal(f.input.value, '输入框草稿');
    // a second conversion, then an edited input draft must not be overwritten
    await click(f.root, '转换文风');
    await f.respond('第二次结果');
    f.input.value = '新草稿';
    await click(f.root, '填回聊天输入框');
    assert.equal(f.input.value, '新草稿');
    assert.match(statusOf(f.root), /不会覆盖新草稿/);
    await click(f.root, '复制结果');
    assert.match(statusOf(f.root), /剪贴板不可用|已复制/);
});

test('late results are discarded after source edits, chat switches keep drafts private, cancel and retry work', async () => {
    const f = fixture();
    await click(f.root, '自定义文风');
    const source = byLabel(f.root, '原文', 'textarea');
    source.value = '原文内容'; fire(source, 'input');
    f.input.value = '';
    await click(f.root, '转换文风');
    source.value = '修改后的原文'; fire(source, 'input');
    assert.match(statusOf(f.root), /原文已修改.*丢弃/);
    await f.respond('迟到结果');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '');
    assert.match(statusOf(f.root), /原文已修改.*丢弃/);

    // chat switch mid-flight: request aborted, per-chat state swapped both ways
    source.value = '聊天A的原文'; fire(source, 'input');
    await click(f.root, '转换文风');
    await f.respond('聊天A的结果');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '聊天A的结果');
    await click(f.root, '转换文风');
    f.ctx.getCurrentChatId = () => 'chat-b';
    f.eventSource.emit('chat_changed');
    await wait();
    assert.match(statusOf(f.root), /聊天已切换/);
    await f.respond('迟到');
    assert.equal(byLabel(f.root, '原文', 'textarea').value, '', 'chat-b starts with a private empty draft');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '');
    assert.equal(descendants(f.root).find(node => node.tagName === 'TEXTAREA' && node.attributes['aria-label'] === '转换结果').parent.hidden, true);
    f.ctx.getCurrentChatId = () => 'chat-a';
    f.eventSource.emit('chat_changed');
    await wait();
    assert.equal(byLabel(f.root, '原文', 'textarea').value, '聊天A的原文');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '聊天A的结果');

    // cancel stops waiting; failures surface a retry that succeeds
    await click(f.root, '转换文风');
    await click(f.root, '取消');
    assert.match(statusOf(f.root), /已停止等待|已取消/);
    assert.equal(byText(f.root, '转换文风').disabled, false);
    await click(f.root, '转换文风');
    await f.fail(new Error('网络错误'));
    assert.match(statusOf(f.root), /网络错误/);
    assert.equal(byText(f.root, '重试').hidden, false);
    await click(f.root, '重试');
    await f.respond('重试成功');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '重试成功');
});

test('reference mode uses chat samples, reports empty chats, and stamps content plus mode and preset changes', async () => {
    const f = fixture();
    const source = byLabel(f.root, '原文', 'textarea');
    source.value = '原文'; fire(source, 'input');
    f.input.value = '';
    await click(f.root, '转换文风');
    assert.match(f.calls[0].request.prompt, /风声掠过塔顶。/);
    assert.match(statusOf(f.root), /样本 2 条/);
    await f.respond('参考结果');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '参考结果');

    const empty = fixture({ chat: [] });
    byLabel(empty.root, '原文', 'textarea').value = '原文';
    fire(byLabel(empty.root, '原文', 'textarea'), 'input');
    await click(empty.root, '转换文风');
    assert.equal(empty.calls.length, 0);
    assert.match(statusOf(empty.root), /没有可参考的正文/);
    assert.match(statusOf(empty.root), /自定义文风/);

    // new chat messages invalidate an in-flight reference result even without CHAT_CHANGED
    const stale = fixture();
    byLabel(stale.root, '原文', 'textarea').value = '原文';
    fire(byLabel(stale.root, '原文', 'textarea'), 'input');
    await click(stale.root, '转换文风');
    stale.ctx.chat = [...stale.ctx.chat, { name: '我', is_user: true, mes: '新消息' }];
    await stale.respond('迟到');
    assert.equal(byLabel(stale.root, '转换结果', 'textarea').value, '');
    assert.match(statusOf(stale.root), /聊天内容已更新.*丢弃/);

    // switching mode or preset mid-flight discards the late result
    const modeSwitch = fixture();
    byLabel(modeSwitch.root, '原文', 'textarea').value = '原文';
    fire(byLabel(modeSwitch.root, '原文', 'textarea'), 'input');
    await click(modeSwitch.root, '转换文风');
    await click(modeSwitch.root, '自定义文风');
    assert.match(statusOf(modeSwitch.root), /已切换为自定义文风/);
    await modeSwitch.respond('迟到');
    assert.equal(byLabel(modeSwitch.root, '转换结果', 'textarea').value, '');

    const presetSwitch = fixture();
    await click(presetSwitch.root, '自定义文风');
    byLabel(presetSwitch.root, '原文', 'textarea').value = '原文';
    fire(byLabel(presetSwitch.root, '原文', 'textarea'), 'input');
    await click(presetSwitch.root, '转换文风');
    const select = byLabel(presetSwitch.root, '文风预设', 'select');
    const other = presetSwitch.ctx.extensionSettings[STORE_KEY].presets.find(p => p.name === '细腻古典');
    select.value = other.id; fire(select, 'change'); await wait();
    assert.match(statusOf(presetSwitch.root), /预设已切换/);
    await presetSwitch.respond('迟到');
    assert.equal(byLabel(presetSwitch.root, '转换结果', 'textarea').value, '');
});

test('source and selected-preset edits during a run invalidate its late result', async () => {
    const f = fixture();
    await click(f.root, '自定义文风');
    const source = byLabel(f.root, '原文', 'textarea');
    source.value = '原文内容'; fire(source, 'input');
    await click(f.root, '转换文风');
    // clearing the source mid-run drops the late result
    await click(f.root, '清空原文');
    assert.match(statusOf(f.root), /原文已修改.*丢弃/);
    await f.respond('迟到1');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '');

    // re-reading the host input mid-run also invalidates
    source.value = '再试一次'; fire(source, 'input');
    f.input.value = '输入框草稿';
    await click(f.root, '转换文风');
    await click(f.root, '读取聊天输入框');
    assert.equal(byLabel(f.root, '原文', 'textarea').value, '输入框草稿');
    assert.match(statusOf(f.root), /原文已修改.*丢弃/);
    await f.respond('迟到2');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '');

    // editing the preset the run is based on invalidates it too
    source.value = '第三次'; fire(source, 'input');
    await click(f.root, '转换文风');
    const desc = byLabel(f.root, '文风说明', 'textarea');
    desc.value = '被编辑的说明'; fire(desc, 'input');
    assert.match(statusOf(f.root), /预设已修改.*丢弃/);
    await f.respond('迟到3');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '');

    // after discarding the edit, a fresh conversion applies normally
    await click(f.root, '放弃修改');
    source.value = '第五次'; fire(source, 'input');
    await click(f.root, '转换文风');
    await f.respond('正常结果');
    assert.equal(byLabel(f.root, '转换结果', 'textarea').value, '正常结果');
});

test('delete confirmation is bound to one preset and undo restores unsaved edits', async () => {
    const f = fixture();
    const select = byLabel(f.root, '文风预设', 'select');
    const presets = () => f.ctx.extensionSettings[STORE_KEY].presets;
    const a = presets().find(p => p.name === '简洁明快');
    const b = presets().find(p => p.name === '细腻古典');

    // arm on A, then switch to B: the confirmation disarms instead of deleting B
    select.value = a.id; fire(select, 'change'); await wait();
    const armedA = await click(f.root, '删除预设');
    assert.match(armedA.textContent, /确认删除「简洁明快」/);
    select.value = b.id; fire(select, 'change'); await wait();
    assert.ok(Boolean(byText(f.root, '删除预设')), 'armed confirmation disarmed after switching presets');
    assert.equal(presets().length, 2);
    const armedB = await click(f.root, '删除预设');
    assert.match(armedB.textContent, /确认删除「细腻古典」/);

    // creating a new preset disarms as well
    await click(f.root, '新建预设');
    assert.ok(Boolean(byText(f.root, '删除预设')), 'armed confirmation disarmed after creating');
    assert.equal(presets().length, 2);

    // edit A unsaved, delete it, undo: the preset and the unsaved edit both return
    select.value = a.id; fire(select, 'change'); await wait();
    const name = byLabel(f.root, '预设名称', 'input');
    name.value = '改名草稿'; fire(name, 'input');
    await click(f.root, '删除预设');
    await click(f.root, '确认删除「简洁明快」？');
    assert.equal(presets().some(p => p.id === a.id), false);
    await click(f.root, '撤销删除');
    assert.ok(presets().some(p => p.id === a.id));
    assert.equal(byLabel(f.root, '文风预设', 'select').value, a.id, 'dropdown selects the restored preset');
    assert.equal(name.value, '改名草稿', 'unsaved edits come back with the preset');
});

test('CRUD renders stay in sync: new opens the editor, save switches label, discard re-renders', async () => {
    const f = fixture();
    const details = () => descendants(f.root).find(node => node.tagName === 'DETAILS');
    details().open = false;
    await click(f.root, '新建预设');
    assert.equal(details().open, true, 'creating auto-opens the editor');
    const name = byLabel(f.root, '预设名称', 'input');
    const desc = byLabel(f.root, '文风说明', 'textarea');
    name.value = '冷峻白描'; fire(name, 'input');
    desc.value = '少形容词，多动作。'; fire(desc, 'input');
    await click(f.root, '保存新预设');
    assert.ok(Boolean(byText(f.root, '保存修改')), 'after saving the button is no longer 保存新预设');
    assert.equal(name.value, '冷峻白描');
    name.value = '冷峻白描改'; fire(name, 'input');
    await click(f.root, '放弃修改');
    assert.equal(name.value, '冷峻白描', 'discard visibly restores the saved content');
    const select = byLabel(f.root, '文风预设', 'select');
    const created = f.ctx.extensionSettings[STORE_KEY].presets.find(p => p.name === '冷峻白描');
    assert.equal(select.value, created.id, 'editor and dropdown follow the saved preset');
});

test('selecting a preset from the new-draft editor keeps the new draft for later', async () => {
    const f = fixture();
    await click(f.root, '新建预设');
    const name = byLabel(f.root, '预设名称', 'input');
    name.value = '未完成草稿'; fire(name, 'input');
    const select = byLabel(f.root, '文风预设', 'select');
    const seed = f.ctx.extensionSettings[STORE_KEY].presets.find(p => p.name === '简洁明快');
    select.value = seed.id; fire(select, 'change'); await wait();
    assert.equal(name.value, '简洁明快', 'editor switched to the chosen preset');
    await click(f.root, '新建预设');
    assert.equal(byLabel(f.root, '预设名称', 'input').value, '未完成草稿', 'the old new-draft survives');
});

test('result edits persist per chat and a failed rerun keeps the old result guarded', async () => {
    const f = fixture();
    await click(f.root, '自定义文风');
    const source = byLabel(f.root, '原文', 'textarea');
    const result = byLabel(f.root, '转换结果', 'textarea');
    source.value = '原文'; fire(source, 'input');
    f.input.value = '';
    await click(f.root, '转换文风');
    await f.respond('原始结果');
    // user edits the result, switches chats and back — the edit survives
    result.value = '手动润色后的结果'; fire(result, 'input');
    f.ctx.getCurrentChatId = () => 'chat-b'; f.eventSource.emit('chat_changed'); await wait();
    assert.equal(result.value, '');
    f.ctx.getCurrentChatId = () => 'chat-a'; f.eventSource.emit('chat_changed'); await wait();
    assert.equal(result.value, '手动润色后的结果');

    // re-establish authorization with a fresh successful run, then break it with a failed rerun
    f.input.value = '';
    await click(f.root, '转换文风');
    await f.respond('第二次结果');
    f.input.value = '新草稿';
    await click(f.root, '转换文风');
    await click(f.root, '填回聊天输入框');
    assert.match(statusOf(f.root), /正在转换中/);
    await f.fail(new Error('模型出错'));
    assert.equal(result.value, '第二次结果', 'old result stays visible');
    await click(f.root, '填回聊天输入框');
    assert.equal(f.input.value, '新草稿', 'old result must not overwrite the new input draft');
    assert.match(statusOf(f.root), /不会覆盖新草稿/);
});

test('a metadata swap without CHAT_CHANGED never sends the old chat source', async () => {
    const f = fixture();
    const source = byLabel(f.root, '原文', 'textarea');
    source.value = '旧聊天的原文'; fire(source, 'input');
    // same id/character, but the host replaced the metadata object (new chat loaded, no event)
    f.ctx.chatMetadata = { note_title: '初见' };
    await click(f.root, '转换文风');
    assert.equal(f.calls.length, 0, 'no request may leave with the old chat source');
    assert.match(statusOf(f.root), /原文/);
    assert.equal(source.value, '', 'source area switched to the new chat draft');
});

test('failed preset saves keep the editing draft and notify the user', async () => {
    const f = fixture({ saveSettingsDebounced() { return Promise.reject(new Error('disk broken')); } });
    const name = byLabel(f.root, '预设名称', 'input');
    const desc = byLabel(f.root, '文风说明', 'textarea');
    await click(f.root, '新建预设');
    name.value = '冷峻悬疑'; fire(name, 'input');
    desc.value = '多用短句。'; fire(desc, 'input');
    await click(f.root, '保存新预设');
    assert.match(statusOf(f.root), /保存失败.*disk broken/);
    assert.equal(name.value, '冷峻悬疑', 'the failed-save draft stays in the editor');
    assert.equal(f.ctx.extensionSettings[STORE_KEY], undefined, 'host value rolled back');
    assert.ok(byLabel(f.root, '文风预设', 'select').textContent.includes('尚无预设'), 'list rolled back');
    // saving again still surfaces the failure without ever losing the draft
    await click(f.root, '保存新预设');
    assert.equal(name.value, '冷峻悬疑');
    assert.match(statusOf(f.root), /保存失败/);
});
test('custom mode never silently uses saved text while the preset editor has unsaved changes', async () => {
 const f=fixture();f.view.setMode('custom');const source=byLabel(f.root,'原文','textarea'),desc=byLabel(f.root,'文风说明','textarea');source.value='原文';fire(source,'input');desc.value='全新文风：干净克制';fire(desc,'input');
 await f.view.convert();assert.equal(f.calls.length,0);assert.match(statusOf(f.root),/先保存/);await click(f.root,'保存修改');await click(f.root,'转换文风');assert.equal(f.calls.length,1);assert.ok(f.calls[0].request.prompt.includes('全新文风：干净克制'));await f.respond('改写');
 await click(f.root,'新建预设');byLabel(f.root,'预设名称','input').value='另一个';desc.value='尚未保存的新文风';fire(desc,'input');await f.view.convert();assert.equal(f.calls.length,1);assert.match(statusOf(f.root),/先保存/);f.view.dispose();
});
test('failed mode persistence keeps visible mode and store mode in sync',async()=>{
 for(const asyncFailure of [false,true]){const f=fixture();f.ctx.saveSettingsDebounced=()=>{if(asyncFailure)return Promise.reject(Error('mode save failed'));throw Error('mode save failed');};assert.doesNotThrow(()=>f.view.setMode('custom'));await wait();assert.equal(byText(f.root,'参考当前聊天文风').getAttribute('aria-pressed'),'true');assert.equal(byText(f.root,'自定义文风').getAttribute('aria-pressed'),'false');assert.equal(f.ctx.extensionSettings[STORE_KEY].mode,'chat');assert.match(statusOf(f.root),/mode save failed/);f.view.dispose();}
});
test('source value comparison rejects unannounced editor replacement during a run',async()=>{
 const f=fixture(),source=byLabel(f.root,'原文','textarea');source.value='第一份';fire(source,'input');await click(f.root,'转换文风');source.value='第二份';await f.respond('旧改写');assert.equal(byLabel(f.root,'转换结果','textarea').value,'');assert.match(statusOf(f.root),/原文.*修改/);f.view.dispose();
});

// Merged-workspace regressions: source transfer and shared content-style editing.
test('candidate handoff never generates or overwrites existing rewrite drafts and checks chat identity', async () => {
    const f=fixture();
    const {chatIdentity}=await import('../apps/stylewriter/model.js');
    const identity=chatIdentity(f.ctx);
    f.view.acceptSource('候选草稿',identity);
    assert.equal(byLabel(f.root,'原文','textarea').value,'候选草稿');assert.equal(f.calls.length,0);
    assert.throws(()=>f.view.acceptSource('另一候选',identity),/已有原文草稿/);
    assert.equal(byLabel(f.root,'原文','textarea').value,'候选草稿');
    f.ctx.getCurrentChatId=()=> 'changed';
    assert.throws(()=>f.view.acceptSource('旧候选',identity),/聊天已变化/);
    assert.equal(byLabel(f.root,'原文','textarea').value,'');
    f.view.dispose();
});
test('content style UI supports create copy delete undo and keeps generation/rewrite choices separate',async()=>{
    const f=fixture({extensionSettings:{reply_options_mvp:{contentMode:'violence',violencePrompt:'原暴力要求'}}});
    const name=byLabel(f.root,'内容风格名称','input'),prompt=byLabel(f.root,'内容风格提示词','textarea');
    assert.equal(byLabel(f.root,'内容风格','select').value,'none');
    name.value='悬疑';fire(name,'input');prompt.value='信息差与线索';fire(prompt,'input');await click(f.root,'保存风格');
    const store=f.ctx.extensionSettings.amin_os_content_styles_v1,preset=store.presets.find(p=>p.name==='悬疑');assert.ok(preset);
    assert.equal(f.ctx.extensionSettings.reply_options_mvp.contentMode,'violence');
    assert.equal(f.ctx.extensionSettings.amin_os_stylewriter_v1.contentMode,preset.id);
    await click(f.root,'复制风格');assert.equal(store.presets.length+1,f.ctx.extensionSettings.amin_os_content_styles_v1.presets.length);
    await click(f.root,'删除风格');await click(f.root,'确认删除');
    assert.equal(byLabel(f.root,'内容风格','select').value,'none');
    await click(f.root,'恢复已删除风格（撤销）');assert.notEqual(byLabel(f.root,'内容风格','select').value,'none');
    f.view.dispose();
});
test('editing selected shared content cancels an in-flight rewrite and blocks reuse until saved',async()=>{
    const f=fixture();await click(f.root,'不额外指定文风');
    const name=byLabel(f.root,'内容风格名称','input'),prompt=byLabel(f.root,'内容风格提示词','textarea');
    name.value='日常';fire(name,'input');prompt.value='原来的日常重点';fire(prompt,'input');await click(f.root,'保存风格');
    const source=byLabel(f.root,'原文','textarea');source.value='原文事实';fire(source,'input');await click(f.root,'转换文风');
    assert.equal(f.calls.length,1);assert.match(f.calls[0].request.systemPrompt,/原来的日常重点/);
    prompt.value='编辑但尚未保存';fire(prompt,'input');await f.respond('过期结果');
    assert.equal(byLabel(f.root,'转换结果','textarea').value,'');
    await click(f.root,'转换文风');assert.equal(f.calls.length,1);assert.match(statusOf(f.root),/先保存或放弃/);
    await click(f.root,'保存风格');await click(f.root,'转换文风');assert.equal(f.calls.length,2);assert.match(f.calls[1].request.systemPrompt,/编辑但尚未保存/);
    await f.respond('新结果');f.view.dispose();
});
