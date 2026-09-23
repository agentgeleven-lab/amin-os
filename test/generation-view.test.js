import test from 'node:test';
import assert from 'node:assert/strict';
import { mountGeneration } from '../apps/generation/view.js';
class Node {
    constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    async dispatch(type) { for (const fn of this.listeners.get(type) ?? []) await fn({ target: this }); }
    querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector === '[data-linkage-lock]' ? node.dataset.linkageLock : selector === '[data-linkage-invalid]' ? node.dataset.linkageInvalid : node.tagName === selector.toUpperCase()); }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this.selected = true; }
}
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label, tag = 'button') => walk(root).find(node => node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); assert.equal(node.disabled, false, 'disabled button: ' + label); await node.dispatch('click'); return node; }
async function toggle(root, label, checked) { const node = find(root, label, 'input'); assert.ok(node, 'missing checkbox: ' + label); assert.equal(node.disabled, false, 'disabled checkbox: ' + label); node.checked = checked; await node.dispatch('change'); return node; }
async function input(root, label, value, tag = 'textarea') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = value; await node.dispatch(tag === 'select' ? 'change' : 'input'); return node; }
const notice = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;


function fixture() {
 const doc = { createElement(tag) { return new Node(tag, doc); } }, root = doc.createElement('div');
 const calls = [], listeners = new Set(); let draft = null, preview = null, dirty = false, failSave = false;
 const service = {
  draft: () => draft, preview: () => preview, dirty: () => dirty, busy: () => false,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async generate(request) { calls.push(['generate', request]); draft = { changes: [{ module: 'characters', action: 'save', data: { name: '甲', quantity: 1, equipped: false, appearance: { hairstyle: '短发' } } }, { module: 'characters', action: 'save', data: { name: '乙' } }], warnings: [] }; },
  stage(changes) { calls.push(['stage', changes]); preview = { changes, valid: true }; },
  async confirm() { calls.push(['confirm']); if (failSave) { dirty = true; throw Error('保存失败'); } preview = null; },
  async retrySave() { calls.push(['retry']); dirty = false; preview = null; },
  discard() { preview = null; }, cancel() { calls.push(['cancel']); },
 };
 const view = mountGeneration(root, { service, getContext: () => ({ chat: [{}, {}, {}] }), mountSources: () => ({ getValue: () => ({ includeCharacter: true, readWorldbooks: false, selectedBooks: [] }), dispose() {} }) });
 return { root, view, calls, service, fail() { failSave = true; } };
}
test('generation panel stays lazy; source ranges convert once and suggestions require selection, preview, confirmation', async () => {
 const f = fixture(); assert.equal(find(f.root, '生成资料草稿'), undefined); f.view.open();
 await toggle(f.root, '读取指定聊天楼层', true); await input(f.root, '起始楼层（从 1 开始）', '2', 'input');
 await click(f.root, '生成资料草稿'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].sources.start, 1); assert.equal(f.calls[0][1].sources.end, 2);
 await toggle(f.root, '采用建议 2 · 人物卡', false);
 await input(f.root, '建议 1 JSON', JSON.stringify({ module: 'characters', action: 'save', data: { name: '修订' } }));
 await click(f.root, '预览所选变更'); assert.deepEqual(f.calls[1][1].map(x => x.data.name), ['修订']); assert.equal(f.calls.length, 2);
 await click(f.root, '返回编辑建议'); assert.equal(f.service.preview(), null); assert.match(find(f.root, '建议 1 JSON', 'textarea').value, /修订/);
 await click(f.root, '预览所选变更'); await click(f.root, '确认保存整组资料'); assert.equal(f.calls.filter(x => x[0] === 'confirm').length, 1); f.view.dispose();
});
test('malformed edits do not stage; failed persistence offers retry without applying a second time', async () => {
 const f = fixture(); f.view.open(); await click(f.root, '生成资料草稿');
 await input(f.root, '建议 1 JSON', '{broken'); await click(f.root, '预览所选变更'); assert.equal(f.calls.length, 1);
 await input(f.root, '建议 1 JSON', '{}'); await click(f.root, '预览所选变更'); f.fail(); await click(f.root, '确认保存整组资料');
 assert.equal(find(f.root, '生成资料草稿').disabled, true); await click(f.root, '重试保存生成资料'); assert.equal(f.calls.filter(x => x[0] === 'confirm').length, 1); assert.equal(f.calls.filter(x => x[0] === 'retry').length, 1); f.view.dispose();
});

test('ordinary translated fields edit strings, quantities, booleans and nested data before staging', async () => {
 const f = fixture(); f.view.open(); await click(f.root, '生成资料草稿');
 assert.match(f.root.textContent, /仅新增，保留已有/);
 const advanced = walk(f.root).find(n => n.tagName === 'SUMMARY' && n.textContent === '高级编辑'); assert.ok(advanced); assert.notEqual(advanced.parent.open, true);
 await input(f.root, '建议 1 · 名称', '普通编辑名', 'input'); await input(f.root, '建议 1 · 数量', '3', 'input');
 await toggle(f.root, '建议 1 · 已装备', true); await input(f.root, '建议 1 · 外观 · 发型', '长发', 'input');
 await click(f.root, '预览所选变更');
 assert.deepEqual(f.calls.at(-1)[1][0].data, { name: '普通编辑名', quantity: 3, equipped: true, appearance: { hairstyle: '长发' } }); f.view.dispose();
});
test('invalid ordinary numeric input blocks stage instead of silently using the previous quantity', async () => {
 const f = fixture(); f.view.open(); await click(f.root, '生成资料草稿'); await input(f.root, '建议 1 · 数量', '', 'input'); await click(f.root, '预览所选变更'); assert.equal(f.calls.length, 1);
 await input(f.root, '建议 1 · 数量', '0', 'input'); await click(f.root, '预览所选变更'); assert.equal(f.calls.at(-1)[1][0].data.quantity, 0); f.view.dispose();
});
