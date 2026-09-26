import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../apps/relationships/view.js';
import { buildRelationshipGraph, renderRelationshipGraph } from '../apps/relationships/graph.js';
import { createRelationshipsService } from '../apps/relationships/service.js';
import { KEY, readRelationships } from '../apps/relationships/model.js';
import { KEY as CHARACTERS_KEY, emptyStore, appendSnapshot } from '../apps/characters/model.js';

class Node {
    constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    async dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) await fn({ type, target: this, preventDefault() {}, ...event }); }
    querySelectorAll(selector) { return walk(this).slice(1).filter(node => selector === '[data-mutation]' ? node.dataset.mutation : selector === '[data-minimum-people]' ? node.dataset.minimumPeople : node.tagName === selector.toUpperCase()); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    focus() { this.ownerDocument.activeElement = this; }
}
const doc = () => { const listeners = new Map(); const document = { createElement: tag => new Node(tag, document), createElementNS: (_, tag) => new Node(tag, document),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); }, listeners }; return document; };
const walk = root => [root, ...root.children.flatMap(walk)];
const find = (root, label, tag = 'button') => walk(root).find(node => node.tagName === tag.toUpperCase() && (node.textContent === label || node.getAttribute('aria-label') === label));
async function click(root, label) { const node = find(root, label); assert.ok(node, 'missing button: ' + label); assert.equal(node.disabled, false, 'button disabled: ' + label); await node.dispatch('click'); }
async function input(root, label, value, tag = 'input') { const node = find(root, label, tag); assert.ok(node, 'missing field: ' + label); node.value = value; await node.dispatch(tag === 'select' ? 'change' : 'input'); return node; }
const notice = root => walk(root).find(node => node.className === 'amin-notice')?.textContent;
const people = [{ id: 'a', name: '艾琳', kind: 'pc', notes: '', stats: [] }, { id: 'b', name: '守卫', kind: 'npc', notes: '', stats: [] }, { id: 'c', name: '医师', kind: 'npc', notes: '', stats: [] }];
function fixture(options = {}) {
    let failure = false, saveCount = 0, serial = 0;
    const newContext = id => ({ characterId: 0, getCurrentChatId: () => id, chat: [{ name: '旅人', is_user: true, mes: '抵达城门' }], chatMetadata: { untouched: 'original' }, saveMetadata: async () => { saveCount++; if (failure) throw Error('disk unavailable'); } });
    let ctx = newContext('chat-a');
    const seed = (characters = people) => { ctx.chatMetadata[CHARACTERS_KEY] = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters }, { id: 'characters-' + ++serial }); };
    seed(); const api = createRelationshipsService(() => ctx, { createId: () => 'rel-' + ++serial, ...options }), document = doc(), root = new Node('main', document), view = mount(root, { api, document });
    return { root, view, api, document, ctx: () => ctx, saveCount: () => saveCount, failure(value) { failure = value; }, characters(value) { seed(value); api.sync(); }, switch() { ctx = newContext('chat-b'); seed(); api.sync(); }, dispose() { view.dispose(); api.dispose(); } };
}
async function stageNew(f, { type = '信任', strength, notes = '' } = {}) {
    await click(f.root, '新增人物关系'); await input(f.root, '关系类型', type);
    if (strength !== undefined) await input(f.root, '强度（可选）', strength);
    if (notes) await input(f.root, '关系备注（可选）', notes, 'textarea');
    await click(f.root, '预览保存关系');
}

test('relationship graph retains directed and reciprocal edges and exposes keyboard-selectable PC/NPC nodes', async () => {
    const relationships = [{ id: 'ab', fromId: 'a', toId: 'b', type: '信任' }, { id: 'ba', fromId: 'b', toId: 'a', type: '怀疑' }];
    const graph = buildRelationshipGraph(people, relationships, 'a');
    assert.equal(graph.nodes.length, 3); assert.deepEqual(graph.edges.map(edge => [edge.from.id, edge.to.id]), [['a', 'b'], ['b', 'a']]); assert.notEqual(graph.edges[0].path, graph.edges[1].path);
    const document = doc(); let focus;
    const rendered = renderRelationshipGraph(document, people, relationships, { onSelect: id => { focus = id; } });
    const node = walk(rendered.element).find(node => node.getAttribute('aria-label') === '聚焦 艾琳 · PC');
    assert.equal(node.getAttribute('role'), 'button'); assert.equal(node.getAttribute('tabindex'), '0'); await node.dispatch('keydown', { key: 'Enter' }); assert.equal(focus, 'a');
    assert.match(rendered.element.textContent, /PC · 玩家人物/); assert.match(rendered.element.textContent, /NPC · 非玩家人物/);
    assert.equal(walk(rendered.element).filter(node => node.tagName === 'PATH' && node.getAttribute('marker-end')).length, 2);
});

test('large graphs disclose truncation and focus finds people beyond the first graph page', () => {
    const many = Array.from({ length: 160 }, (_, index) => ({ id: 'p' + index, name: '人物' + index, kind: 'npc' }));
    const edges = many.slice(1).map((person, index) => ({ id: 'e' + index, fromId: 'p0', toId: person.id, type: '认识' }));
    const overview = buildRelationshipGraph(many, edges); assert.equal(overview.nodes.length, 128); assert.equal(overview.totalNodes, 160); assert.equal(overview.omittedNodes, 32);
    const focused = buildRelationshipGraph(many, edges, 'p159'); assert.ok(focused.nodes.some(p => p.id === 'p159' && p.emphasis === 'focus')); assert.ok(focused.nodes.some(p => p.emphasis === 'muted')); assert.equal(focused.edges.filter(e => e.active).length, 1);
});

test('two-person graph fits a 220px container without scaling down 50px touch targets', () => {
    const graph = buildRelationshipGraph(people.slice(0, 2), [{ id: 'ab', fromId: 'a', toId: 'b', type: '信任' }], 'a', { width: 220 });
    assert.equal(graph.width, 220); assert.equal(graph.nodes.length, 2);
    for (const person of graph.nodes) { assert.ok(person.x - 78 >= 0); assert.ok(person.x + 78 <= graph.width); assert.ok(person.y - 25 >= 0); assert.ok(person.y + 25 <= graph.height); }
    assert.ok(Math.abs(graph.nodes[0].y - graph.nodes[1].y) > 50);
    assert.equal(graph.edges.length, 1);
});

test('new directed relation is only saved after explicit preview confirmation, without default strength or reciprocal edge', async () => {
    const f = fixture(); try {
        await stageNew(f, { notes: '<script>not markup</script>' });
        assert.equal(f.ctx().chatMetadata[KEY], undefined); assert.match(f.root.textContent, /待确认 · 新建人物关系/);
        await click(f.root, '确认应用一次');
        const state = readRelationships(f.ctx()); assert.equal(state.relationships.length, 1); assert.equal(state.relationships[0].fromId, 'a'); assert.equal(state.relationships[0].toId, 'b'); assert.equal(Object.hasOwn(state.relationships[0], 'strength'), false);
        assert.equal(state.settings.includeInContext, false); assert.equal(state.relationships[0].notes, '<script>not markup</script>'); assert.equal(walk(f.root).some(node => node.tagName === 'SCRIPT'), false);
        assert.equal(f.saveCount(), 1); assert.equal(f.ctx().chatMetadata.untouched, 'original'); assert.equal(find(f.root, '预览保存关系'), undefined); assert.match(notice(f.root), /已保存/);
    } finally { f.dispose(); }
});

test('edit and delete each require preview and accessible list actions preserve explicit zero strength', async () => {
    const f = fixture(); try {
        await stageNew(f, { strength: '0' }); await click(f.root, '确认应用一次');
        assert.equal(readRelationships(f.ctx()).relationships[0].strength, 0);
        await click(f.root, '编辑关系：艾琳 → 守卫'); await input(f.root, '关系类型', '合作'); await click(f.root, '预览保存关系');
        assert.equal(readRelationships(f.ctx()).relationships[0].type, '信任'); await click(f.root, '取消预览');
        assert.equal(find(f.root, '关系类型', 'input').value, '合作'); await click(f.root, '预览保存关系'); await click(f.root, '确认应用一次');
        assert.equal(readRelationships(f.ctx()).relationships[0].type, '合作');
        await click(f.root, '预览删除：艾琳 → 守卫'); assert.equal(readRelationships(f.ctx()).relationships.length, 1); await click(f.root, '确认应用一次'); assert.equal(readRelationships(f.ctx()).relationships.length, 0);
    } finally { f.dispose(); }
});

test('failed persistence leaves one confirmed relation and retry does not duplicate it', async () => {
    const f = fixture(); try {
        await stageNew(f); f.failure(true); await click(f.root, '确认应用一次');
        assert.match(notice(f.root), /disk unavailable/); assert.equal(f.api.dirty(), true); assert.equal(f.ctx().chatMetadata[KEY].events.length, 1); assert.ok(find(f.root, '重试保存'));
        f.failure(false); await click(f.root, '重试保存'); assert.equal(f.ctx().chatMetadata[KEY].events.length, 1); assert.equal(readRelationships(f.ctx()).relationships.length, 1); assert.equal(f.saveCount(), 2); assert.equal(find(f.root, '预览保存关系'), undefined);
    } finally { f.dispose(); }
});

test('chat switch keeps draft text visible but rejects saving it into another chat', async () => {
    const f = fixture(); try {
        await click(f.root, '新增人物关系'); await input(f.root, '关系类型', '尚未确认的手写关系'); const old = f.ctx();
        f.switch(); assert.equal(find(f.root, '关系类型', 'input').value, '尚未确认的手写关系'); assert.match(notice(f.root), /已变化/);
        await click(f.root, '预览保存关系'); assert.match(notice(f.root), /已变化/); assert.equal(old.chatMetadata[KEY], undefined); assert.equal(f.ctx().chatMetadata[KEY], undefined);
        await click(f.root, '取消编辑'); assert.equal(find(f.root, '预览保存关系'), undefined);
    } finally { f.dispose(); }
});

test('missing person references remain explicit and editable while new relations are disabled without two people', async () => {
    const f = fixture(); try {
        await stageNew(f); await click(f.root, '确认应用一次'); f.characters([people[0]]);
        assert.match(f.root.textContent, /未解析人物（b）/); assert.equal(find(f.root, '新增人物关系').disabled, true);
        await click(f.root, '编辑关系：艾琳 → 未解析人物（b）'); await input(f.root, '关系备注（可选）', '保留离场人物的原引用', 'textarea'); await click(f.root, '预览保存关系'); await click(f.root, '确认应用一次');
        assert.equal(readRelationships(f.ctx()).relationships[0].toId, 'b'); assert.equal(readRelationships(f.ctx()).relationships[0].notes, '保留离场人物的原引用'); assert.equal(find(f.root, '新增人物关系').disabled, true);
    } finally { f.dispose(); }
});

test('person focus and direction filter the accessible list without requiring graph interaction', async () => {
    const f = fixture(); try {
        await stageNew(f); await click(f.root, '确认应用一次');
        await click(f.root, '新增人物关系'); await input(f.root, '关系发起者', 'b', 'select'); await input(f.root, '关系对象', 'a', 'select'); await input(f.root, '关系类型', '怀疑'); await click(f.root, '预览保存关系'); await click(f.root, '确认应用一次');
        await input(f.root, '聚焦人物', 'a', 'select'); await input(f.root, '关系方向', 'in', 'select');
        assert.ok(find(f.root, '编辑关系：守卫 → 艾琳')); assert.equal(find(f.root, '编辑关系：艾琳 → 守卫'), undefined);
        await input(f.root, '搜索人物、类型或备注', '不存在'); assert.match(f.root.textContent, /没有符合当前筛选/);
    } finally { f.dispose(); }
});

test('mount and dispose are idempotent and settings remain opt-in behind confirmation', async () => {
    const f = fixture();
    try {
        assert.equal(mount(f.root, { api: f.api, document: f.document }), f.view); assert.equal(f.root.children.length, 1);
        const input = find(f.root, '普通正文读取人物关系', 'input'); assert.equal(input.checked, false); input.checked = true;
        await click(f.root, '预览读取设置'); assert.equal(readRelationships(f.ctx()).settings.includeInContext, false); await click(f.root, '确认应用一次'); assert.equal(readRelationships(f.ctx()).settings.includeInContext, true);
    } finally { f.dispose(); }
    f.view.dispose(); assert.equal(f.root.children.length, 0);
});

test('threshold editor previews a rule, exposes a crossed reminder and acknowledges it without creating story events', async () => {
    const f = fixture();
    try {
        await stageNew(f, { strength: '1' }); await click(f.root, '确认应用一次');
        await click(f.root, '新增阈值规则'); await input(f.root, '阈值数值', '5'); await input(f.root, '阈值提醒内容', '可以检查合作意愿，但不代表事件已发生', 'textarea');
        await click(f.root, '预览保存阈值'); assert.equal(readRelationships(f.ctx()).thresholdRules, undefined);
        await click(f.root, '确认应用一次'); assert.equal(readRelationships(f.ctx()).thresholdRules.length, 1); assert.equal(find(f.root, '预览保存阈值'), undefined);
        await click(f.root, '编辑关系：艾琳 → 守卫'); await input(f.root, '强度（可选）', '6'); await input(f.root, '本次调整依据（可选）', '已经完成约定的救援', 'textarea'); await click(f.root, '预览保存关系');
        assert.match(f.root.textContent, /阈值提醒（不是剧情事件）/); assert.equal(readRelationships(f.ctx()).thresholdAlerts, undefined);
        await click(f.root, '确认应用一次'); assert.equal(readRelationships(f.ctx()).thresholdAlerts.length, 1); assert.match(f.root.textContent, /关系阈值提醒 · 1 项/);
        await click(f.root, '预览标记已读'); assert.equal(readRelationships(f.ctx()).thresholdAlerts[0].acknowledged, false);
        await click(f.root, '确认应用一次'); assert.equal(readRelationships(f.ctx()).thresholdAlerts[0].acknowledged, true); assert.match(f.root.textContent, /已经完成约定的救援/);
        assert.equal(readRelationships(f.ctx()).relationships.length, 1);
    } finally { f.dispose(); }
});

test('relationship analysis shows exact source and reason only after an explicit batch confirmation', async () => {
    const ai = { capture: () => ({}), generate: async () => JSON.stringify({ version: 1, changes: [{ module: 'relationships', action: 'save', target: 'new_relation', data: { fromId: 'a', toId: 'b', type: '认识', sources: [0] }, reason: '艾琳在城门与守卫相识。' }] }) };
    const f = fixture({ ai });
    try {
        await click(f.root, '分析所选剧情'); assert.match(f.root.textContent, /待确认 · 剧情关系建议 · 1 项/); assert.match(f.root.textContent, /来源：第 1 楼/);
        assert.equal(readRelationships(f.ctx()).relationships.length, 0); await click(f.root, '确认应用一次');
        assert.equal(readRelationships(f.ctx()).relationships[0].id, 'new_relation'); assert.equal(f.saveCount(), 1);
        assert.match(f.root.textContent, /AI 建议确认/); assert.match(f.root.textContent, /抵达城门/); assert.match(f.root.textContent, /艾琳在城门与守卫相识/);
    } finally { f.dispose(); }
});

test('character entry focuses the stable ID and its document listener is removed on disposal', async () => {
    const f = fixture();
    try {
        f.document.dispatchEvent({ type: 'amin:select-character', detail: { app: 'relationships', characterId: 'b' } });
        assert.equal(find(f.root, '聚焦人物', 'select').value, 'b');
        f.document.dispatchEvent({ type: 'amin:select-character', detail: { app: 'inventory', characterId: 'a' } });
        assert.equal(find(f.root, '聚焦人物', 'select').value, 'b');
        assert.equal(f.document.listeners.get('amin:select-character').size, 1);
    } finally { f.dispose(); }
    assert.equal(f.document.listeners.get('amin:select-character').size, 0);
});


test('4 to 32 people have disjoint cards in overview and focused graphs', () => {
    for (let count = 4; count <= 32; count++) {
        const chars = Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: '人物' + i }));
        const edges = chars.slice(1).map((p, i) => ({ id: 'e' + i, fromId: 'p0', toId: p.id, type: '认识' }));
        for (const focus of ['', 'p0']) {
            const graph = buildRelationshipGraph(chars, edges, focus, { width: 280 });
            for (const [i, a] of graph.nodes.entries()) {
                assert.ok(a.x >= 78 && a.x + 78 <= graph.width && a.y >= 25 && a.y + 25 <= graph.height);
                for (const b of graph.nodes.slice(i + 1)) assert.ok(Math.abs(a.x - b.x) >= 156 || Math.abs(a.y - b.y) >= 50, `overlap at ${count}`);
            }
        }
    }
});

test('dense relations use one full text detail and selectable highlighted edges', async () => {
    const edges = Array.from({length: 20}, (_, i) => ({ id: 'e' + i, fromId: 'a', toId: 'b', type: '很长的关系说明'.repeat(12) + i }));
    const {element} = renderRelationshipGraph(doc(), people, edges);
    const groups = walk(element).filter(n => n.getAttribute('class') === 'amin-relationship-edge');
    assert.equal(groups.length, 20);
    assert.ok(groups.every(g => !g.children.some(n => n.tagName === 'TEXT')));
    await groups[7].dispatch('click');
    assert.equal(groups[7].getAttribute('data-selected'), 'true');
    assert.equal(groups[0].getAttribute('data-selected'), 'false');
    assert.ok(walk(element).find(n => n.getAttribute('role') === 'status').textContent.endsWith(edges[7].type));
    const picker = find(element, '查看图中关系', 'select'); picker.value = '2'; await picker.dispatch('change');
    assert.equal(groups[2].getAttribute('data-selected'), 'true');
});


test('focus keeps map positions and fades only unrelated people; ring is non-overlapping', () => {
    const chars = Array.from({length: 20}, (_, i) => ({id: 'p'+i, name:'人物'+i}));
    const edges = [{id:'ab',fromId:'p0',toId:'p2',type:'信任'}, {id:'bc',fromId:'p2',toId:'p3',type:'认识'}];
    for (const layout of ['map', 'ring']) {
        const a = buildRelationshipGraph(chars,edges,'',{layout}), b = buildRelationshipGraph(chars,edges,'p0',{layout});
        assert.deepEqual(a.nodes.map(n=>[n.id,n.x,n.y]),b.nodes.map(n=>[n.id,n.x,n.y]));
        assert.equal(b.nodes[0].emphasis,'focus'); assert.equal(b.nodes[2].emphasis,'related'); assert.equal(b.nodes[3].emphasis,'muted');
        assert.equal(b.edges[0].active,true); assert.equal(b.edges[1].active,false);
        for (const [i,n] of b.nodes.entries()) for(const m of b.nodes.slice(i+1)) assert.ok(Math.abs(n.x-m.x)>=156 || Math.abs(n.y-m.y)>=50);
    }
});

test('map direct edge bypasses intermediate card instead of implying chained relationships', () => {
    const graph = buildRelationshipGraph(people,[{id:'ac',fromId:'a',toId:'c',type:'信任'}]);
    const edge = graph.edges[0];
    assert.match(edge.path,/ H .* V .* H .* V /);
    assert.ok(edge.path.startsWith(`M ${edge.from.x+78} ${edge.from.y}`));
    assert.ok(edge.path.endsWith(`V ${edge.to.y-32}`));
});


test('network uses compact circles, stable focus positions and keeps manually moved nodes', () => {
    const chars = Array.from({length:20},(_,i)=>({id:'p'+i,name:'人物'+i}));
    const edges=chars.slice(1).map((p,i)=>({id:'e'+i,fromId:'p'+i,toId:p.id,type:'同伴'}));
    const a=buildRelationshipGraph(chars,edges,'',{layout:'network'}),b=buildRelationshipGraph(chars,edges,'p2',{layout:'network'});
    assert.deepEqual(a.nodes.map(n=>[n.x,n.y]),b.nodes.map(n=>[n.x,n.y]));
    for(const [i,n] of a.nodes.entries())for(const m of a.nodes.slice(i+1))assert.ok(Math.abs(n.x-m.x)>100 || Math.abs(n.y-m.y)>65);
    const moved=buildRelationshipGraph(chars,edges,'p2',{layout:'network',savedPositions:new Map([['p2',{x:130,y:200}]])});
    assert.equal(moved.nodes[2].x,130);assert.equal(moved.nodes[2].y,200);
    const {element}=renderRelationshipGraph(doc(),chars,edges,{layout:'network'});
    assert.equal(walk(element).filter(n=>n.tagName==='RECT').length,0);
    assert.equal(walk(element).filter(n=>n.getAttribute('class')==='amin-node-dot').length,20);
});
