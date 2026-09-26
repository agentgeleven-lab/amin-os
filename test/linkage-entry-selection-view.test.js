import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContextBudgetControls, renderContextBudgetReport } from '../apps/linkage/context-budget-view.js';
class Node {
    constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.handlers = {}; this.value = ''; this._text = ''; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, fn) { this.handlers[event] = fn; }
    dispatch(event) { this.handlers[event]?.(); }
}
function fixture() { const document = { createElement: tag => new Node(tag, document) }; return new Node('main', document); }
const walk = root => [root, ...root.children.flatMap(walk)];
const aria = (root, label) => walk(root).find(node => node.attributes['aria-label'] === label);
const button = (root, label) => walk(root).find(node => node.tagName === 'button' && node.textContent === label);
const entries = Array.from({ length: 65 }, (_, n) => ({ id: `characters:c${n}`, module: 'characters', label: `人物${n}`, included: n < 3, required: n === 0, reason: n < 3 ? '当前场景' : '与当前场景无关联' }));
test('entry selection edits only the parent draft and preserves invisible pins without adding private catalog entries', () => {
    const root = fixture(), settings = { contextBudget: { enabled: false, maxChars: 24000, requiredModules: [], entrySelection: { enabled: false, pinned: ['characters:old'] } } };
    let draft;
    const result = renderContextBudgetControls(root, { settings, report: { entrySelection: { entries } }, onChange: value => { draft = value; } });
    const toggle = aria(root, '启用条目级资料筛选'); toggle.checked = true; toggle.dispatch('change');
    assert.equal(draft.entrySelection.enabled, true); assert.equal(draft.enabled, false); assert.equal(settings.contextBudget.entrySelection.enabled, false);
    const select = aria(root, '固定资料条目'); select.value = 'characters:c2'; button(root, '固定选中条目').dispatch('click');
    assert.deepEqual(draft.entrySelection.pinned, ['characters:old', 'characters:c2']);
    select.value = 'characters:old'; button(root, '取消固定选中条目').dispatch('click');
    assert.deepEqual(draft.entrySelection.pinned, ['characters:c2']);
    const pin = button(root, '固定选中条目'); pin.disabled = true; select.value = 'characters:c4'; pin.dispatch('click');
    assert.deepEqual(draft.entrySelection.pinned, ['characters:c2']);
    assert.ok(result.inputs.includes(select)); assert.ok(result.inputs.includes(pin));
    assert.match(root.textContent, /所有模块都开启写权限/);
    const search = aria(root, '搜索固定资料条目'); search.value = '人物64'; search.dispatch('input');
    assert.equal(select.children.length, 2); assert.match(select.textContent, /人物64/);
});
test('report limits visible entry rows and provides search with reasons as safe text', () => {
    const root = fixture(); renderContextBudgetReport(root, { modules: [], usedChars: 1200, enabled: false, entrySelection: { enabled: true, entries: [...entries, { id: 'characters:x', module: 'characters', label: '<img src=x>', included: false, reason: '不允许' }] } });
    assert.match(root.textContent, /66 项 · 第 1 \/ 3 页/);
    assert.equal(walk(root).filter(node => node.className === 'amin-notice').length, 30);
    button(root, '下一页').dispatch('click'); assert.match(root.textContent, /第 2 \/ 3 页/);
    const search = aria(root, '搜索资料纳入预览'); search.value = '<img'; search.dispatch('input');
    assert.match(root.textContent, /1 项 · 第 1 \/ 1 页/); assert.match(root.textContent, /未纳入 · 不允许/);
    assert.equal(walk(root).some(node => node.tagName === 'img'), false);
});
test('controls remain usable without report or new saved settings', () => {
    const root = fixture(); let draft;
    renderContextBudgetControls(root, { settings: {}, onChange: value => { draft = value; } });
    const toggle = aria(root, '启用条目级资料筛选'); toggle.checked = true; toggle.dispatch('change');
    assert.deepEqual(draft.entrySelection, { enabled: true, pinned: [] }); assert.match(root.textContent, /可选 0 项/);
});
