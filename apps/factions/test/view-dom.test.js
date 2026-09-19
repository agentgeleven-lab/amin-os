// DOM stub 回归测试：view.js 的渲染纪律——任何重渲染先清空容器，杜绝视图实例叠加。
// （0.9.2 之前的 bug：标签栏与创建向导在交互后不断 append 累积，node 测试无 DOM 而漏检。）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign, createFaction, createRegion } from '../model.js';
import { KEY } from '../service.js';

// ---- 极简记录型 DOM 节点，覆盖 view.js 用到的全部 API ----
function makeNode(tag) {
    const node = {
        tagName: String(tag).toLowerCase(), children: [], attributes: {}, style: { setProperty(key, value) { this[key] = value; } },
        className: '', textContent: '', value: '', type: '', title: '',
        checked: false, disabled: false, hidden: false, selected: false, rows: 0, maxLength: Infinity,
        onclick: null, onchange: null, parentNode: null,
        append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); if (this.tagName === 'select' && k.tagName === 'option') this.options.push(k); } },
        replaceChildren() { for (const k of this.children) k.parentNode = null; this.children.length = 0; if (this.tagName === 'select') this.options.length = 0; },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; },
        closest(selector) { let n = this; while (n) { if (n.tagName === selector) return n; n = n.parentNode; } return null; },
        remove() { if (this.parentNode) { const list = this.parentNode.children; const index = list.indexOf(this); if (index >= 0) list.splice(index, 1); this.parentNode = null; } },
        get lastChild() { return this.children[this.children.length - 1] ?? null; },
    };
    if (node.tagName === 'select') node.options = [];
    return node;
}

// ---- 浏览器全局 stub：必须在 import view.js 之前就位 ----
const storage = new Map();
globalThis.document = { createElement: makeNode };
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
let currentChat = 'chat-dom-1';
globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => currentChat, groupId: '', characterId: 0, characters: [], chat: [], eventTypes: {}, eventSource: null }) };

const walk = node => { const out = [node]; for (const k of node.children) out.push(...walk(k)); return out; };
const byClass = (node, cls) => walk(node).filter(n => String(n.className).split(/\s+/).includes(cls));
const pageOf = target => target.children.find(n => n.className.includes('amin-page'));
const panelOf = page => page.children.find(n => n.tagName === 'section');
const tabsOf = page => page.children.find(n => n.className === 'amin-tabs');

test('repeated renders keep exactly one tab bar', async () => {
    currentChat = 'chat-dom-1';
    const campaign = createCampaign({ scaleTemplate: 'street', name: 'DOM 测试棋局' });
    const f = createFaction(campaign, { name: '甲' });
    campaign.factions.push(f);
    campaign.regions.push(createRegion(campaign, { name: '东城', controller: f.id }));
    storage.set(KEY + ':||chat-dom-1', JSON.stringify({ version: 1, campaigns: [campaign], activeId: campaign.id, follow: false }));
    const { mount } = await import('../view.js');
    const target = makeNode('div');
    const view = mount(target);
    const page = pageOf(target), body = panelOf(page), tabs = tabsOf(page);
    assert.equal(tabs.children.length, 4, '初次渲染 4 个页签');
    await view.open(); await view.open();
    assert.equal(tabs.children.length, 4, 'open() 重渲染不叠加页签');
    await tabs.children[1].onclick();
    assert.equal(tabs.children.length, 4, '切换页签不叠加');
    assert.ok(byClass(body, 'amin-fx-region').length >= 1, '内容已切到地区网格');
    await view.open();
    assert.equal(tabs.children.length, 4, '再次 open 仍不叠加');
});

test('wizard template clicks never stack wizard cards', async () => {
    currentChat = 'chat-dom-2'; // 无存储棋局 → 向导模式
    const { mount } = await import('../view.js');
    const target = makeNode('div');
    mount(target);
    const body = panelOf(pageOf(target));
    assert.equal(byClass(body, 'amin-card').length, 1, '向导只有一张卡');
    assert.equal(byClass(body, 'amin-fx-region').length, 4, '四个模板卡');
    const card = byClass(body, 'amin-fx-region')[1];
    await card.onclick(); await card.onclick(); await card.onclick();
    assert.equal(byClass(body, 'amin-card').length, 1, '重复点击模板卡不叠加向导');
    assert.equal(byClass(body, 'amin-fx-region').length, 4, '模板卡恒为 4 个');
});

test('opening a region form replaces the grid instead of stacking', async () => {
    currentChat = 'chat-dom-1';
    const { mount } = await import('../view.js');
    const target = makeNode('div');
    mount(target);
    const page = pageOf(target), body = panelOf(page);
    await tabsOf(page).children[1].onclick();
    const grid = byClass(body, 'amin-fx-region');
    assert.ok(grid.length >= 1, '地区网格就位');
    const tools = grid[0].children.find(n => n.className === 'amin-toolbar');
    await tools.children[0].onclick(); // 「版图变更」
    assert.equal(byClass(body, 'amin-fx-region').length, 0, '表单打开后网格被替换');
    assert.equal(byClass(body, 'amin-card').length, 1, '只有一张表单卡，无叠加');
});

test('mounting twice keeps a single page instance', async () => {
    currentChat = 'chat-dom-2';
    const { mount } = await import('../view.js');
    const target = makeNode('div');
    const first = mount(target);
    const second = mount(target);
    assert.equal(target.children.length, 1, '重复 mount 只留一个页面实例');
    assert.equal(walk(target).filter(n => n.className.includes('amin-page')).length, 1);
    first.open(); // 旧句柄在 dispose 后调用仍安全
    assert.equal(target.children.length, 1, '旧句柄不复活实例');
    assert.equal(typeof second.open, 'function');
});
