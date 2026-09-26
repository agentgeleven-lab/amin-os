import { uuid } from '../../uuid.js';

const SVG = 'http://www.w3.org/2000/svg';
const MAX_NODES = 128;
export const personLabel = person => person ? `${person.name} · ${person.kind === 'pc' ? 'PC' : person.kind === 'npc' ? 'NPC' : '未解析'}` : '未解析人物';

/** Deterministic, bounded view data. The complete edge list remains available in the editor. */
export function buildRelationshipGraph(characters, relationships, focusId = '', { width: availableWidth, layout = 'map', activeEdgeIds = null } = {}) {
    const people = new Map(characters.map(person => [person.id, { ...person, missing: false }]));
    for (const edge of relationships) for (const id of [edge.fromId, edge.toId]) {
        if (!people.has(id)) people.set(id, { id, name: `未解析人物（${id}）`, missing: true });
    }
    const relevant = relationships;
    // Keep positions stable while focusing: unrelated people remain in context.
    const ids = [...people.keys()];
    const shown = ids.slice(0, MAX_NODES);
    if (focusId && people.has(focusId) && !shown.includes(focusId)) shown[shown.length - 1] = focusId;
    const compact = shown.length <= 3;
    const active = new Set(activeEdgeIds ?? relationships.filter(e => !focusId || e.fromId === focusId || e.toId === focusId).map(e => e.id));
    const related = new Set([focusId, ...relationships.filter(e => active.has(e.id)).flatMap(e => [e.fromId, e.toId])]);
    const levels = new Map(), allowed = new Set(shown);
    const neighbours = new Map(shown.map(id => [id, new Set()]));
    for (const edge of relationships) if (allowed.has(edge.fromId) && allowed.has(edge.toId)) { neighbours.get(edge.fromId).add(edge.toId); neighbours.get(edge.toId).add(edge.fromId); }
    // Connectivity layers, not inferred kinship. Cycles and reciprocal edges remain edges.
    let base = 0;
    const roots = [...shown].sort((a,b) => Number(people.get(b).kind === 'pc') - Number(people.get(a).kind === 'pc'));
    for (const root of roots) if (!levels.has(root)) {
        levels.set(root, base); const queue = [root]; let deepest = base;
        for (let i = 0; i < queue.length; i++) for (const id of neighbours.get(queue[i])) if (!levels.has(id)) { const level = levels.get(queue[i]) + 1; levels.set(id, level); deepest = Math.max(deepest, level); queue.push(id); }
        base = deepest + 1;
    }
    const rows = new Map();
    shown.forEach(id => { const level = levels.get(id); if (!rows.has(level)) rows.set(level, []); rows.get(level).push(id); });
    const radius = Math.max(190, 190 / (2 * Math.sin(Math.PI / Math.max(3, shown.length))));
    const ring = layout === 'ring' && !compact;
    const columns = Math.max(2, Math.min(4, Math.floor((availableWidth || 920) / 230)));
    const slots = new Map(); let rowOffset = 0;
    for (const [, row] of [...rows.entries()].sort((a,b) => a[0] - b[0])) { row.forEach((id, i) => slots.set(id, { col: i % columns, row: rowOffset + Math.floor(i / columns) })); rowOffset += Math.ceil(row.length / columns); }
    const width = ring ? Math.ceil(radius * 2 + 190) : compact ? Math.max(220, Math.min(520, availableWidth || 520)) : columns * 230;
    const height = ring ? Math.ceil(radius * 2 + 110) : Math.max(180, rowOffset * 140);
    const nodes = shown.map((id, index) => {
        const angle = index * Math.PI * 2 / shown.length - Math.PI / 2;
        const slot = slots.get(id);
        const x = ring ? width / 2 + radius * Math.cos(angle) : compact ? width / 2 : (slot.col + .5) * 230;
        const y = ring ? height / 2 + radius * Math.sin(angle) : slot.row * 140 + 55;
        return { ...people.get(id), x, y: compact ? index * 140 + 55 : y, emphasis: !focusId ? 'normal' : id === focusId ? 'focus' : related.has(id) ? 'related' : 'muted' };
    });
    const canvasHeight = compact ? Math.max(180, shown.length * 140) : height;
    const positions = new Map(nodes.map(node => [node.id, node]));
    const edges = relevant.filter(edge => positions.has(edge.fromId) && positions.has(edge.toId)).map((edge, index, all) => {
        const from = positions.get(edge.fromId), to = positions.get(edge.toId);
        const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy) || 1;
        // Clip lines at rectangular node boundaries so arrow heads remain visible.
        const clip = Math.min(78 / Math.max(Math.abs(dx / distance), .001), 25 / Math.max(Math.abs(dy / distance), .001));
        const start = { x: from.x + dx / distance * clip, y: from.y + dy / distance * clip };
        const end = { x: to.x - dx / distance * (clip + 7), y: to.y - dy / distance * (clip + 7) };
        const parallel = all.filter(item => item.fromId === edge.fromId && item.toId === edge.toId);
        const order = parallel.findIndex(item => item.id === edge.id);
        const reciprocal = all.some(item => item.fromId === edge.toId && item.toId === edge.fromId);
        const bend = (parallel.length > 1 ? (order - (parallel.length - 1) / 2) * 34 : 0) + (reciprocal ? 24 : 0);
        const cx = (start.x + end.x) / 2 - dy / distance * bend, cy = (start.y + end.y) / 2 + dx / distance * bend;
        const lane = Math.min(width - from.x - 8, 95 + (index % 5) * 5);
        const route = `M ${from.x + 78} ${from.y} H ${from.x + lane} V ${to.y - 45} H ${to.x} V ${to.y - 32}`;
        return { ...edge, from, to, active: active.has(edge.id), path: ring ? `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}` : route, labelX: (start.x + 2 * cx + end.x) / 4, labelY: (start.y + 2 * cy + end.y) / 4 - 6, index };
    });
    return { nodes, edges, width, height: canvasHeight, totalNodes: ids.length, totalEdges: relevant.length, omittedNodes: Math.max(0, ids.length - nodes.length), omittedEdges: Math.max(0, relevant.length - edges.length) };
}

export function renderRelationshipGraph(document, characters, relationships, { focusId = '', onSelect = () => {}, width, layout = 'map', activeEdgeIds = null } = {}) {
    const graph = buildRelationshipGraph(characters, relationships, focusId, { width, layout, activeEdgeIds });
    const container = document.createElement('div'); container.className = 'amin-stack';
    const details = document.createElement('p'); details.className = 'amin-relationship-direction'; details.setAttribute('role', 'status');
    details.textContent = '选择一条关系查看完整说明；点击人物可聚焦。';
    const picker = document.createElement('select'); picker.setAttribute('aria-label', '查看图中关系');
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择关系查看完整说明'; picker.append(placeholder);
    const groups = [], personGroups = [];
    const selectEdge = index => {
        const edge = graph.edges[index];
        details.textContent = edge ? `${edge.from.name} → ${edge.to.name}：${edge.label || edge.type}${edge.strength !== undefined ? ' · 强度：' + edge.strength : ''}` : '选择一条关系查看完整说明；点击人物可聚焦。';
        picker.value = edge ? String(index) : '';
        personGroups.forEach((group, i) => { const person = graph.nodes[i]; group.setAttribute('data-emphasis', edge ? (person.id === edge.fromId || person.id === edge.toId ? 'related' : 'muted') : person.emphasis); });
        groups.forEach((group, i) => group.setAttribute('data-selected', edge ? String(i === index) : 'none'));
    };
    picker.addEventListener('change', () => selectEdge(picker.value === '' ? -1 : Number(picker.value)));
    container.append(picker, details);
    const wrap = document.createElement('div'); wrap.className = 'amin-relationships-graph-scroll';
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '有向人物关系图，可横向滚动；完整关系见下方列表'); wrap.tabIndex = 0;
    const make = (tag, attributes = {}, text) => {
        const element = document.createElementNS(SVG, tag);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
        if (text != null) element.textContent = text;
        return element;
    };
    const id = 'amin-rel-' + uuid(), svg = make('svg', { viewBox: `0 0 ${graph.width} ${graph.height}`, width: graph.width, height: graph.height, class: 'amin-relationships-graph', 'aria-label': '人物关系地图', 'aria-describedby': id + '-description' });
    svg.append(make('desc', { id: id + '-description' }, '箭头从关系发起者指向对象。选择人物可聚焦其关系。每一条关系都在下方列表提供文字与编辑操作。'));
    const defs = make('defs'), marker = make('marker', { id: id + '-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
    marker.append(make('path', { d: 'M 0 0 L 10 5 L 0 10 Z', class: 'amin-relationship-arrow' })); defs.append(marker); svg.append(defs);
    for (const edge of graph.edges) {
        const group = make('g', { class: 'amin-relationship-edge', 'data-relationship-id': edge.id, 'data-relevant': String(edge.active) });
        const label = `${edge.from.name} → ${edge.to.name}：${edge.label || edge.type}`;
        const option = document.createElement('option'); option.value = String(edge.index); option.textContent = label; picker.append(option);
        group.append(make('title', {}, label), make('path', { d: edge.path, 'marker-end': `url(#${id}-arrow)` }), make('path', { d: edge.path, class: 'amin-relationship-hit' }));
        group.addEventListener('click', () => selectEdge(edge.index)); groups.push(group);
        svg.append(group);
    }
    for (const person of graph.nodes) {
        const group = make('g', { transform: `translate(${person.x} ${person.y})`, class: 'amin-relationship-person', role: 'button', tabindex: '0', 'aria-label': '聚焦 ' + personLabel(person), 'aria-pressed': String(focusId === person.id), 'data-person-id': person.id, 'data-emphasis': person.emphasis });
        group.append(make('title', {}, personLabel(person)), make('rect', { x: -78, y: -25, width: 156, height: 50, rx: 8 }), make('text', { y: -3, 'text-anchor': 'middle' }, Array.from(person.name).slice(0, 13).join('') + (Array.from(person.name).length > 13 ? '…' : '')), make('text', { y: 15, 'text-anchor': 'middle', class: 'amin-relationship-person-kind' }, person.missing ? '人物引用未解析' : person.kind === 'pc' ? 'PC · 玩家人物' : 'NPC · 非玩家人物'));
        group.addEventListener('click', () => onSelect(person.id));
        group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(person.id); } });
        personGroups.push(group); svg.append(group);
    }
    const zoomTools = document.createElement('div'); zoomTools.className = 'amin-toolbar';
    let zoom = 1;
    const applyZoom = value => { zoom = Math.max(.15, Math.min(2, value)); svg.setAttribute('width', graph.width * zoom); svg.setAttribute('height', graph.height * zoom); };
    for (const [label, action] of [['缩小地图', () => applyZoom(zoom / 1.25)], ['放大地图', () => applyZoom(zoom * 1.25)], ['查看全图', () => { applyZoom(Math.min(1, (wrap.clientWidth || graph.width) / graph.width, (wrap.clientHeight || graph.height) / graph.height)); wrap.scrollLeft = 0; wrap.scrollTop = 0; }], ['原始大小', () => applyZoom(1)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); zoomTools.append(button);
    }
    wrap.append(svg); container.append(zoomTools, wrap);
    const connections = document.createElement('div'); connections.className = 'amin-relationship-connections';
    if (focusId) for (const edge of graph.edges.filter(e => e.active)) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${edge.from.name} → ${edge.to.name}：${edge.label || edge.type}`;
        button.addEventListener('click', () => selectEdge(edge.index)); connections.append(button);
    }
    container.append(connections);
    document.defaultView?.requestAnimationFrame?.(() => {
        if (!wrap.isConnected) return;
        const anchor = graph.nodes.find(node => node.id === focusId) ?? graph.nodes[0];
        if (!anchor) return;
        wrap.scrollLeft = Math.max(0, anchor.x - wrap.clientWidth / 2);
        wrap.scrollTop = Math.max(0, anchor.y - 90);
    });

    return { element: container, graph };
}
