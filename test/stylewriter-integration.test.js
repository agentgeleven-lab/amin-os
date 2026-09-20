// End-to-end wiring check for stylewriter: default mount (no injected generate) runs the real
// view → generator (rewriteText) → shared AI service chain against an in-memory transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../ai/service.js';
import { mount } from '../apps/stylewriter/view.js';
import { KEY, empty, change } from '../apps/effects/model.js';

// ---- Minimal DOM double: only the subset the stylewriter view uses. ----
class FakeEvent { constructor(type) { this.type = type; } }
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.style = {};
        this.listeners = new Map(); this._text = ''; this._className = '';
        this.value = ''; this.hidden = false; this.disabled = false; this.type = ''; this.rows = 0; this.id = ''; this.open = false;
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
    dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event); return true; }
    focus() {} select() {}
}
const wait = async (ticks = 30) => { for (let i = 0; i < ticks; i++) await new Promise(resolve => setImmediate(resolve)); };
function* walk(node) { yield node; for (const child of [...node.children]) yield* walk(child); }
const descendants = root => [...walk(root)];
const byLabel = (root, label, tag) => descendants(root).find(node => node.tagName === tag.toUpperCase() && node.attributes['aria-label'] === label);
const byText = (root, text) => descendants(root).find(node => node.tagName === 'BUTTON' && node.textContent === text);
const statusOf = root => descendants(root).find(node => node.className.includes('amin-notice')).textContent;
const fire = (node, type) => node.dispatchEvent(new FakeEvent(type));
const click = async (root, text) => { const button = byText(root, text); if (!button) throw Error('button not found: ' + text); button.dispatchEvent(new FakeEvent('click')); await wait(); };

const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; };
const bodies = [];
let serviceCtx = null;
const transport = {
    resolveConnection: async (config, ctx) => { serviceCtx = ctx; return { ...config, enabled: true, baseUrl: 'https://mock.test/v1' }; },
    fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        bodies.push({ url, body });
        const content = await serviceCtx.mockGenerate({ responseLength: body.max_tokens, systemPrompt: body.messages[0].content, prompt: body.messages.slice(1).map(m => m.content).join('\n') });
        return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
    },
};

test('default view→generator→shared-service chain is wired and leak-free in custom mode', async () => {
    const ai = createAI(storage(), 'sw-integration', transport);
    ai.settings.save({ ...ai.settings.snapshot(), enabled: true, baseUrl: 'https://global.test/v1', model: 'integ-model' });
    const chat = [{ name: '艾琳', is_user: false, mes: '风声掠过塔顶。' }];
    // effects live in chatMetadata to prove includeEffects:false keeps them out of the request
    const seed = { ...empty(), skills: [{ id: 's', name: '技能', book: 'b', entryId: '1', reminder: 'EFFECT-RULE' }] };
    const state = change(seed, chat, 'create', { skillId: 's', holder: 'a', target: 'b', scope: 'vision', condition: 'manual' });
    const input = new FakeNode('textarea');
    const doc = { createElement: tag => new FakeNode(tag), querySelector: selector => (selector === '#send_textarea' ? input : null), defaultView: { navigator: {} } };
    const ctx = {
        getCurrentChatId: () => 'chat-i', characterId: 0, groupId: null, name1: '我', name2: '艾琳',
        characters: [{ avatar: 'a.png', name: '艾琳' }],
        chatMetadata: { [KEY]: state }, chat,
        extensionSettings: {}, saveSettingsDebounced() {},
        mockGenerate: async request => request.prompt,
    };
    const target = new FakeNode('div');
    // No `generate` injection: the view must call the real rewriteText and pass its service through.
    const view = mount(target, { document: doc, getContext: () => ctx, ai: () => ai });
    const root = descendants(target).find(node => node.id === 'stylewriter-app');
    await click(root, '自定义文风');
    const source = byLabel(root, '原文', 'textarea');
    source.value = '集成原文'; fire(source, 'input');
    input.value = '宿主草稿';
    await click(root, '转换文风');
    assert.match(statusOf(root), /完成.*自定义文风/);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].body.model, 'integ-model');
    const sent = JSON.stringify(bodies[0].body.messages);
    assert.ok(sent.includes('集成原文'), 'the source is sent verbatim');
    assert.ok(sent.includes('动词优先'), 'the preset description is included');
    assert.ok(!sent.includes('风声掠过塔顶。'), 'chat prose must not leak into custom mode');
    assert.ok(!sent.includes('EFFECT-RULE'), 'effect rules must not leak');
    assert.ok(!sent.includes('艾琳'), 'persona names must not leak');
    assert.ok(byLabel(root, '转换结果', 'textarea').value.includes('集成原文'), 'the echoed rewrite lands in the result area');
    view.dispose();
});
