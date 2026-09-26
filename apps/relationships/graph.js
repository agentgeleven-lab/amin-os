import { uuid } from '../../uuid.js';

const SVG = 'http://www.w3.org/2000/svg';
const MAX_NODES = 32;
export const personLabel = person => person ? `${person.name} · ${person.kind === 'pc' ? 'PC' : person.kind === 'npc' ? 'NPC' : '未解析'}` : '未解析人物';

/** Deterministic, bounded view data. The complete edge list remains available in the editor. */
export function buildRelationshipGraph(characters, relationships, focusId = '', { width: availableWidth } = {}) {
    const people = new Map(characters.map(person => [person.id, { ...person, missing: false }]));
    for (const edge of relationships) for (const id of [edge.fromId, edge.toId]) {
        if (!people.has(id)) people.set(id, { id, name: `未解析人物（${id}）`, missing: true });
    }
    const relevant = focusId ? relationships.filter(edge => edge.fromId === focusId || edge.toId === focusId) : relationships;
    const ids = focusId ? [...new Set([focusId, ...relevant.flatMap(edge => [edge.fromId, edge.toId])])] : [...people.keys()];
    const shown = ids.filter(id => people.has(id)).slice(0, MAX_NODES);
    const compact = shown.length <= 3;
    // Fixed-size cells keep every card readable; the canvas grows vertically.
    const width = compact ? Math.max(220, Math.min(520, availableWidth || 520)) : Math.max(440, Math.min(880, availableWidth || 880));
    const columns = Math.max(2, Math.floor(width / 220));
    const offset = focusId && !compact ? 1 : 0;
    const height = compact ? Math.max(180, shown.length * 120) : (Math.ceil((shown.length - offset) / columns) + offset) * 130;
    const nodes = shown.map((id, index) => {
        if (compact) return { ...people.get(id), x: width / 2, y: shown.length === 1 ? height / 2 : 45 + index * (height - 90) / (shown.length - 1) };
        if (offset && index === 0) return { ...people.get(id), x: width / 2, y: 45 };
        const cell = index - offset;
        return { ...people.get(id), x: (cell % columns + .5) * width / columns, y: (Math.floor(cell / columns) + offset) * 130 + 45 };
    });
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
        return { ...edge, from, to, path: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`, labelX: (start.x + 2 * cx + end.x) / 4, labelY: (start.y + 2 * cy + end.y) / 4 - 6, index };
    });
    return { nodes, edges, width, height, totalNodes: ids.length, totalEdges: relevant.length, omittedNodes: Math.max(0, ids.length - nodes.length), omittedEdges: Math.max(0, relevant.length - edges.length) };
}

export function renderRelationshipGraph(document, characters, relationships, { focusId = '', onSelect = () => {}, width } = {}) {
    const graph = buildRelationshipGraph(characters, relationships, focusId, { width });
    const container = document.createElement('div'); container.className = 'amin-stack';
    const details = document.createElement('p'); details.className = 'amin-relationship-direction'; details.setAttribute('role', 'status');
    details.textContent = '选择一条关系查看完整说明；点击人物可聚焦。';
    const picker = document.createElement('select'); picker.setAttribute('aria-label', '查看图中关系');
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择关系查看完整说明'; picker.append(placeholder);
    const groups = [];
    const selectEdge = index => {
        const edge = graph.edges[index];
        details.textContent = edge ? `${edge.from.name} → ${edge.to.name}：${edge.label || edge.type}${edge.strength !== undefined ? ' · 强度：' + edge.strength : ''}` : '选择一条关系查看完整说明；点击人物可聚焦。';
        picker.value = edge ? String(index) : '';
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
    const id = 'amin-rel-' + uuid(), svg = make('svg', { viewBox: `0 0 ${graph.width} ${graph.height}`, width: graph.width, height: graph.height, class: 'amin-relationships-graph', 'aria-labelledby': id + '-title ' + id + '-description' });
    svg.append(make('title', { id: id + '-title' }, '人物关系图'), make('desc', { id: id + '-description' }, '箭头从关系发起者指向对象。选择人物可聚焦其关系。每一条关系都在下方列表提供文字与编辑操作。'));
    const defs = make('defs'), marker = make('marker', { id: id + '-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
    marker.append(make('path', { d: 'M 0 0 L 10 5 L 0 10 Z', class: 'amin-relationship-arrow' })); defs.append(marker); svg.append(defs);
    for (const edge of graph.edges) {
        const group = make('g', { class: 'amin-relationship-edge', 'data-relationship-id': edge.id });
        const label = `${edge.from.name} → ${edge.to.name}：${edge.label || edge.type}`;
        const option = document.createElement('option'); option.value = String(edge.index); option.textContent = label; picker.append(option);
        group.append(make('title', {}, label), make('path', { d: edge.path, 'marker-end': `url(#${id}-arrow)` }), make('path', { d: edge.path, class: 'amin-relationship-hit' }));
        group.addEventListener('click', () => selectEdge(edge.index)); groups.push(group);
        svg.append(group);
    }
    for (const person of graph.nodes) {
        const group = make('g', { transform: `translate(${person.x} ${person.y})`, class: 'amin-relationship-person', role: 'button', tabindex: '0', 'aria-label': '聚焦 ' + personLabel(person), 'aria-pressed': String(focusId === person.id), 'data-person-id': person.id });
        group.append(make('title', {}, personLabel(person)), make('rect', { x: -78, y: -25, width: 156, height: 50, rx: 8 }), make('text', { y: -3, 'text-anchor': 'middle' }, Array.from(person.name).slice(0, 13).join('') + (Array.from(person.name).length > 13 ? '…' : '')), make('text', { y: 15, 'text-anchor': 'middle', class: 'amin-relationship-person-kind' }, person.missing ? '人物引用未解析' : person.kind === 'pc' ? 'PC · 玩家人物' : 'NPC · 非玩家人物'));
        group.addEventListener('click', () => onSelect(person.id));
        group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(person.id); } });
        svg.append(group);
    }
    wrap.append(svg); container.append(wrap);
    return { element: container, graph };
}
