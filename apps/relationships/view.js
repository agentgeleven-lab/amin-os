import { createRelationshipsService, getSharedRelationshipsService } from './service.js';
import { personLabel, renderRelationshipGraph } from './graph.js';

const mounted = new WeakMap();

export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const document = options.document ?? target.ownerDocument ?? globalThis.document;
    const ownService = !options.api && !options.service && !!options.getContext;
    const api = options.api ?? options.service ?? (ownService ? createRelationshipsService(options.getContext) : getSharedRelationshipsService());
    const make = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
    const page = make('section', '', 'amin-page amin-app-page amin-relationships');
    const context = make('div', '', 'amin-context'), notice = make('div', '', 'amin-notice');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const retryPanel = make('div', '', 'amin-stack'), review = make('div', '', 'amin-stack'), controls = make('div', '', 'amin-card amin-stack');
    const graphPanel = make('section', '', 'amin-card amin-stack'), editorHost = make('section', '', 'amin-stack');
    const listPanel = make('section', '', 'amin-stack'), settingsPanel = make('details', '', 'amin-card amin-stack');
    page.append(context, notice, retryPanel, controls, graphPanel, editorHost, review, listPanel, settingsPanel); target.append(page);
    let state = null, characters = [], focusId = '', direction = 'all', query = '', editor = null, disposed = false, error = '', committedEditor = false, unavailable = false, graphWidth = 0;
    const locked = () => unavailable || api.busy() || api.dirty() || !!api.preview();
    const say = (message, failed = false) => { error = failed ? message : ''; notice.textContent = message; notice.dataset.state = failed ? 'error' : api.busy() ? 'busy' : message ? 'success' : ''; };
    const run = async task => { try { error = ''; await task(); } catch (reason) { say(reason?.message ?? String(reason), true); } finally { if (!disposed) updateLocks(); } };
    function button(label, task, { primary = false, mutation = false, disabled = false } = {}) {
        const node = make('button', label, primary ? 'amin-primary' : ''); node.type = 'button'; node.disabled = disabled || (mutation && locked());
        if (mutation) node.dataset.mutation = 'true';
        node.addEventListener('click', () => { if (!node.disabled) return run(task); }); return node;
    }
    function field(parent, label, value, change, { multi = false, type = 'text', help = '', full = false } = {}) {
        const row = make('label', '', 'amin-field' + (full ? ' amin-span-full' : '')), input = make(multi ? 'textarea' : 'input');
        input.value = value ?? ''; input.setAttribute('aria-label', label); if (!multi) input.type = type;
        if (type === 'number') input.step = 'any';
        input.addEventListener('input', () => { change(input.value); }); row.append(make('span', label), input); if (help) row.append(make('small', help)); parent.append(row); return input;
    }
    function select(parent, label, value, choices, change) {
        const row = make('label', '', 'amin-field'), input = make('select'); input.setAttribute('aria-label', label);
        for (const [id, text] of choices) { const option = make('option', text); option.value = id; input.append(option); }
        input.value = value; input.addEventListener('change', () => change(input.value)); row.append(make('span', label), input); parent.append(row); return input;
    }
    const person = id => characters.find(item => item.id === id) ?? { id, name: `未解析人物（${id}）`, missing: true };
    const description = edge => `${person(edge.fromId).name} → ${person(edge.toId).name}`;
    function updateLocks() {
        const busy = api.busy(), block = locked(); page.setAttribute('aria-busy', String(busy));
        for (const node of page.querySelectorAll?.('[data-mutation]') ?? []) node.disabled = block || (node.dataset.minimumPeople === 'true' && characters.length < 2);
        if (editor) for (const node of editor.inputs) node.disabled = block;
        if (editor?.save) editor.save.disabled = block || (!editor.draft.id && characters.length < 2);
    }
    function clearEditor() { editor = null; committedEditor = false; editorHost.replaceChildren(); }
    function openEditor(relationship = null) {
        if (editor) { say('还有一份关系草稿。请先预览保存，或取消编辑。', true); return; }
        if (locked()) throw Error('请先处理待确认操作或重试保存。');
        const draft = relationship ? structuredClone(relationship) : { fromId: focusId || characters[0]?.id || '', toId: characters.find(item => item.id !== (focusId || characters[0]?.id))?.id || '', type: '', label: '', notes: '' };
        const token = api.capture(), panel = make('section', '', 'amin-card amin-stack amin-relationship-editor');
        panel.append(make('h3', relationship ? '编辑人物关系' : '新增人物关系'), make('p', '从发起者指向对象。反向关系需要单独建立；强度由你明确填写，可留空。', 'amin-meta'));
        const form = make('div', '', 'amin-form-grid'); panel.append(form);
        const inputs = [];
        const choices = [['', '请选择人物'], ...characters.map(item => [item.id, personLabel(item)])];
        for (const [key, label] of [['fromId', '关系发起者'], ['toId', '关系对象']]) {
            const available = [...choices];
            if (draft[key] && !characters.some(item => item.id === draft[key])) available.push([draft[key], person(draft[key]).name + ' · 保留原引用']);
            inputs.push(select(form, label, draft[key], available, value => { draft[key] = value; }));
        }
        inputs.push(field(form, '关系类型', draft.type, value => { draft.type = value; }, { help: '例如信任、师徒、敌对、亲属。' }));
        inputs.push(field(form, '关系标签（可选）', draft.label, value => { draft.label = value; }, { help: '图上优先显示此标签；留空显示关系类型。' }));
        inputs.push(field(form, '强度（可选）', draft.strength, value => { if (value.trim() === '') delete draft.strength; else draft.strength = Number(value); }, { type: 'number', help: '没有默认好感值；数值含义由你的规则决定。' }));
        inputs.push(field(form, '关系备注（可选）', draft.notes, value => { draft.notes = value; }, { multi: true, full: true }));
        const actions = make('div', '', 'amin-toolbar');
        const save = button('预览保存关系', () => { api.stage('save', { relationship: draft }, token); render(); }, { primary: true, mutation: true });
        actions.append(save, button('取消编辑', () => { if (api.preview()) api.discard(); clearEditor(); render(); say('已取消编辑。'); }));
        panel.append(actions); editorHost.replaceChildren(panel); editor = { draft, token, panel, inputs, save }; updateLocks(); inputs[0]?.focus();
    }
    function renderControls() {
        controls.replaceChildren(make('h3', '关系视图'));
        const form = make('div', '', 'amin-form-grid');
        const extra = [...new Set((state?.relationships ?? []).flatMap(edge => [edge.fromId, edge.toId]))].filter(id => !characters.some(item => item.id === id));
        select(form, '聚焦人物', focusId, [['', '全部人物'], ...characters.map(item => [item.id, personLabel(item)]), ...extra.map(id => [id, person(id).name])], value => { focusId = value; direction = 'all'; renderControls(); renderGraph(); renderList(); });
        const directionSelect = select(form, '关系方向', direction, [['all', '全部方向'], ['out', '该人物指向别人'], ['in', '别人指向该人物']], value => { direction = value; renderList(); });
        directionSelect.disabled = !focusId;
        field(form, '搜索人物、类型或备注', query, value => { query = value; renderList(); }, { full: true });
        const actions = make('div', '', 'amin-toolbar');
        const create = button('新增人物关系', () => openEditor(), { primary: true, mutation: true, disabled: characters.length < 2 }); create.dataset.minimumPeople = 'true';
        actions.append(create); controls.append(form, actions);
        if (characters.length < 2) controls.append(make('p', '先在人物应用中建立至少两个人物，再选择关系两端。已有关系仍保留。', 'amin-empty'));
    }
    function renderGraph() {
        graphPanel.replaceChildren(make('h3', '有向关系图'), make('p', '箭头：发起者 → 对象。点击或用键盘选择人物可聚焦；下方列表提供完整文字与编辑操作。', 'amin-meta'));
        graphWidth = graphPanel.clientWidth || 0;
        const style = document.defaultView?.getComputedStyle?.(graphPanel);
        const availableWidth = graphWidth ? graphWidth - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0) - 2 : undefined;
        const result = renderRelationshipGraph(document, characters, state.relationships, { focusId, width: availableWidth, onSelect: id => { focusId = id; direction = 'all'; renderControls(); renderGraph(); renderList(); controls.querySelector?.('select')?.focus(); } });
        if (!result.graph.nodes.length) { graphPanel.append(make('p', '还没有人物。请先到人物应用建立人物资料。', 'amin-empty')); return; }
        graphPanel.append(result.element);
        if (result.graph.omittedNodes || result.graph.omittedEdges) graphPanel.append(make('p', `图中显示 ${result.graph.nodes.length} / ${result.graph.totalNodes} 个人物、${result.graph.edges.length} / ${result.graph.totalEdges} 条关系。可聚焦人物缩小范围；下方列表保留全部符合筛选的关系。`, 'amin-meta'));
    }
    function renderList() {
        listPanel.replaceChildren();
        const search = query.trim().toLocaleLowerCase();
        const entries = state.relationships.filter(edge => (!focusId || (direction === 'out' ? edge.fromId === focusId : direction === 'in' ? edge.toId === focusId : edge.fromId === focusId || edge.toId === focusId)) && (!search || [person(edge.fromId).name, person(edge.toId).name, edge.type, edge.label, edge.notes].join('\n').toLocaleLowerCase().includes(search)));
        listPanel.append(make('h3', `关系列表 · ${entries.length} 条`));
        if (!entries.length) { listPanel.append(make('p', state.relationships.length ? '没有符合当前筛选的关系。' : '还没有已确认的人物关系。', 'amin-empty')); return; }
        const list = make('ul', '', 'amin-stack amin-relationships-list');
        for (const edge of entries) {
            const item = make('li', '', 'amin-card amin-stack');
            item.append(make('p', description(edge), 'amin-relationship-direction'), make('p', `类型：${edge.type}${edge.label ? ' · 标签：' + edge.label : ''}`));
            item.append(make('p', `${personLabel(person(edge.fromId))} → ${personLabel(person(edge.toId))}`, 'amin-meta'));
            if (edge.strength !== undefined) item.append(make('p', '已设强度：' + edge.strength));
            if (edge.notes) item.append(make('p', edge.notes, 'amin-relationship-notes'));
            if (person(edge.fromId).missing || person(edge.toId).missing) item.append(make('p', '部分人物在当前分支不存在。保留原 ID 引用；可编辑为当前人物，不会按同名人物自动替换。', 'amin-meta'));
            const actions = make('div', '', 'amin-toolbar');
            const edit = button('编辑关系', () => openEditor(edge), { mutation: true }); edit.setAttribute('aria-label', '编辑关系：' + description(edge));
            const remove = button('预览删除', () => { if (editor) throw Error('请先保存或取消关系草稿。'); api.stage('delete', { id: edge.id }, api.capture()); render(); }, { mutation: true }); remove.setAttribute('aria-label', '预览删除：' + description(edge)); remove.className = 'amin-danger';
            actions.append(edit, remove); item.append(actions); list.append(item);
        }
        listPanel.append(list); updateLocks();
    }
    function renderReview() {
        review.replaceChildren(); const pending = api.preview(); if (!pending) return;
        const panel = make('section', '', 'amin-card amin-stack amin-result'); panel.append(make('h3', '待确认 · ' + pending.label));
        const summary = typeof pending.summary === 'string' ? pending.summary : Array.isArray(pending.summary) ? pending.summary.join('\n') : pending.summary ? JSON.stringify(pending.summary, null, 2) : '';
        if (summary) panel.append(make('p', summary, 'amin-relationship-notes'));
        if (pending.relationship) { const edge = pending.relationship; panel.append(make('p', description(edge), 'amin-relationship-direction'), make('p', `类型：${edge.type}${edge.label ? ' · 标签：' + edge.label : ''}${edge.strength !== undefined ? ' · 强度：' + edge.strength : ''}`)); if (edge.notes) panel.append(make('p', edge.notes, 'amin-relationship-notes')); }
        const actions = make('div', '', 'amin-toolbar');
        actions.append(button('确认应用一次', async () => {
            const savesEditor = pending.op === 'save' && !!editor;
            try { await api.confirm(); if (savesEditor) clearEditor(); render(); say('关系操作已保存。'); }
            catch (reason) { committedEditor = savesEditor && api.dirty(); render(); throw reason; }
        }, { primary: true, disabled: api.busy() }), button('取消预览', () => { api.discard(); render(); }, { disabled: api.busy() }));
        panel.append(actions); review.append(panel);
    }
    function renderSettings() {
        const open = settingsPanel.open; settingsPanel.replaceChildren(make('summary', '上下文读取设置')); settingsPanel.open = open;
        settingsPanel.append(make('p', '默认仅本地记录。启用后，普通正文生成可读取当前分支、人物引用完整的已确认关系；草稿和其他分支不参与。', 'amin-meta'));
        if (!api.supported) settingsPanel.append(make('p', '当前宿主未提供完整的普通正文读取接口。可保存设置，宿主接口可用时才会附加关系。', 'amin-meta'));
        const row = make('label', '', 'amin-check'), input = make('input'); input.type = 'checkbox'; input.checked = !!state.settings.includeInContext; input.setAttribute('aria-label', '普通正文读取人物关系'); input.disabled = locked();
        row.append(input, make('span', '普通正文读取人物关系（当前分支、人物引用完整）')); settingsPanel.append(row);
        settingsPanel.append(button('预览读取设置', () => { if (editor) throw Error('请先保存或取消关系草稿。'); api.stage('settings', { includeInContext: input.checked }, api.capture()); render(); }, { mutation: true }));
    }
    function render() {
        if (disposed) return;
        try { api.capture(); state = api.read(); characters = api.characters(); unavailable = false; }
        catch (reason) {
            unavailable = true; say(reason.message, true); context.textContent = '人物关系 · 当前聊天数据不可读取';
            for (const panel of [controls, graphPanel, review, listPanel, settingsPanel, retryPanel]) panel.replaceChildren();
            updateLocks(); return;
        }
        const people = new Set([...characters.map(item => item.id), ...state.relationships.flatMap(edge => [edge.fromId, edge.toId])]);
        if (focusId && !people.has(focusId)) { focusId = ''; direction = 'all'; }
        context.textContent = `人物关系 · 当前聊天 / 当前分支 · ${characters.length} 个人物 · ${state.relationships.length} 条有向关系 · ${state.settings.includeInContext ? '已允许 AI 读取' : '仅本地记录'}`;
        renderControls(); renderGraph(); renderList(); renderReview(); renderSettings(); retryPanel.replaceChildren();
        if (api.dirty()) {
            const card = make('section', '', 'amin-card amin-stack'); card.append(make('h3', '保存尚未完成'), make('p', '已确认操作保留在当前聊天内存中。重试只保存同一项变更，不重复建立关系。'), button('重试保存', async () => { await api.retrySave(); if (committedEditor) clearEditor(); render(); say('已保存此前确认的关系操作。'); }, { primary: true, disabled: api.busy() })); retryPanel.append(card);
        }
        if (editor && !api.dirty()) { try { api.check(editor.token); } catch { error = '聊天、分支或人物资料已变化。关系草稿仍在此处，可复制内容；请取消编辑后重新选择人物。'; } }
        say(error || api.status(), !!error); updateLocks();
    }
    const unsubscribe = api.subscribe(render); render();
    const Observer = document.defaultView?.ResizeObserver;
    const observer = Observer ? new Observer(() => { if (!disposed && !unavailable && state && graphPanel.clientWidth > 0 && Math.abs(graphPanel.clientWidth - graphWidth) > .5) renderGraph(); }) : null;
    observer?.observe(graphPanel);
    const view = { open() { if (!disposed) { api.sync?.(); render(); } }, dispose() { if (disposed) return; disposed = true; observer?.disconnect(); unsubscribe(); if (ownService) api.dispose(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); return view;
}
