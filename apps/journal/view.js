import { uuid } from '../../uuid.js';
import { STATUSES, change, compile, inspectEntries, filterEntries, sourceFromRange, exportRecords, parseImport } from './model.js';
import { createJournal, getSharedService } from './service.js';
import { readCurrentScene, formatGameTime } from '../scene/model.js';

const mounted = new WeakMap();
const tabNames = { hook: '伏笔', chronicle: '编年史', references: '引用预览', transfer: '导入 / 导出' };

export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const doc = options.document ?? target.ownerDocument ?? document;
    const ownService = !options.api && !!options.getContext;
    const api = options.api ?? (ownService ? createJournal(options.getContext, options.ai ? { ai: options.ai } : {}) : getSharedService());
    const make = (tag, text = '', className = '') => { const element = doc.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
    const instance = 'journal-' + uuid();
    const page = make('section', '', 'amin-page amin-app-page amin-journal'), context = make('div', '', 'amin-context');
    const tabs = make('div', '', 'amin-tabs'), notice = make('div', '', 'amin-notice'), body = make('section', '', 'amin-stack');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '剧情档案页面');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    body.id = instance + '-body'; body.setAttribute('role', 'tabpanel');
    page.append(context, tabs, notice, body); target.append(page);
    let selected = 'hook', form = null, controller = null, disposed = false;
    const filters = { query: '', status: '', scope: 'current', dueOnly: false };
    const say = (text, state = '') => { if (!disposed) { notice.textContent = text; notice.dataset.state = state; } };
    const stop = () => { controller?.abort(); controller = null; };
    const touch = () => { if (form) { form.dirty = true; form.revision++; } };
    body.addEventListener('input', touch); body.addEventListener('change', touch);

    function button(parent, label, action, primary = false) {
        const element = make('button', label, primary === true ? 'amin-primary' : typeof primary === 'string' ? primary : '');
        element.type = 'button'; element.addEventListener('click', async () => {
            if (element.disabled || disposed) return;
            element.disabled = true;
            try { await action(); } catch (error) { say(error.message, 'error'); }
            finally { element.disabled = false; }
        }); parent.append(element); return element;
    }
    function field(parent, label, value = '', multiline = false) {
        const row = make('label', '', 'amin-field' + (multiline ? ' amin-span-full' : ''));
        const input = make(multiline ? 'textarea' : 'input'); input.value = String(value ?? ''); input.setAttribute('aria-label', label);
        if (multiline) input.rows = 5; row.append(make('span', label), input); parent.append(row); return input;
    }
    function select(parent, label, choices, value = '') {
        const row = make('label', '', 'amin-field'), input = make('select'); input.setAttribute('aria-label', label);
        for (const [id, text] of choices) { const option = make('option', text); option.value = id; input.append(option); }
        input.value = value; row.append(make('span', label), input); parent.append(row); return input;
    }
    function checkbox(parent, label, checked = false) {
        const row = make('label', '', 'amin-check'), input = make('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label);
        row.append(input, make('span', label)); parent.append(row); return input;
    }
    function section(title, parent = body, className = 'amin-card amin-stack') {
        const card = make('section', '', className); if (title) card.append(make('h3', title)); parent.append(card); return card;
    }
    function grid(parent) { const box = make('div', '', 'amin-form-grid'); parent.append(box); return box; }
    function toolbar(parent, className = 'amin-toolbar') { const box = make('div', '', className); parent.append(box); return box; }
    function go(action) {
        if (form && (form.dirty || controller)) { say('有未保存的编辑，请先保存或点击“取消编辑”。'); return; }
        stop(); form = null; action();
    }
    function finish(message) { stop(); form = null; render(); say(message, 'success'); }
    function currentTime() {
        try { const scene = readCurrentScene(api.context()); return { clock: structuredClone(scene.clock), label: scene.clock ? formatGameTime(scene.clock, scene.periods) : '' }; }
        catch { return { clock: null, label: '' }; }
    }
    function drawTabs() {
        tabs.replaceChildren();
        for (const [id, label] of Object.entries(tabNames)) {
            const element = button(tabs, label, () => go(() => { selected = id; filters.status = ''; render(); }));
            element.id = instance + '-tab-' + id; element.setAttribute('role', 'tab'); element.setAttribute('aria-controls', body.id);
            element.setAttribute('aria-selected', String(selected === id)); element.tabIndex = selected === id ? 0 : -1;
            element.addEventListener('keydown', event => {
                const ids = Object.keys(tabNames), index = ids.indexOf(id); let next;
                if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
                else if (event.key === 'ArrowLeft') next = ids[(index + ids.length - 1) % ids.length];
                else if (event.key === 'Home') next = ids[0]; else if (event.key === 'End') next = ids.at(-1); else return;
                event.preventDefault(); go(() => { selected = next; filters.status = ''; render(); [...tabs.children].find(tab => tab.getAttribute('aria-selected') === 'true')?.focus(); });
            });
        }
        body.setAttribute('aria-labelledby', instance + '-tab-' + selected);
    }

    function showSources(parent, entry) {
        const details = make('details'); details.append(make('summary', '来源与保存位置')); parent.append(details);
        if (entry.gameTimeText) details.append(make('p', '剧情时间：' + entry.gameTimeText, 'amin-meta'));
        if (entry.savedAt) details.append(make('p', `保存于第 ${entry.savedFloor} 楼 · ${new Date(entry.savedAt).toLocaleString()}`, 'amin-meta'));
        if (entry.sourceNote) details.append(make('p', entry.sourceNote, 'amin-meta'));
        if (entry.sources) {
            details.append(make('p', `来源：第 ${entry.sources.start + 1}–${entry.sources.end + 1} 楼（保存时的正文）`, 'amin-meta'));
            for (const source of entry.sources.messages) {
                const block = make('details'); block.append(make('summary', `第 ${source.index + 1} 楼 · ${source.name || (source.isUser ? '用户' : '角色')}`), make('pre', source.text)); details.append(block);
            }
        } else details.append(make('p', '尚未绑定本聊天来源，不能启用引用。', 'amin-meta'));
    }

    function openForm(entry = null, copy = false) {
        stop();
        const token = api.capture(), ctx = api.check(token), kind = entry?.kind ?? selected;
        const time = currentTime(), chat = ctx.chat ?? [], latestFloor = Math.max(1, chat.length), editable = entry && !copy;
        const savedClock = editable ? structuredClone(entry.gameTime) : copy ? structuredClone(entry.gameTime) : time.clock;
        const initialTimeText = editable ? entry.gameTimeText : entry?.gameTimeText || time.label;
        const state = { token, id: editable ? entry.id : uuid(), dirty: false, revision: 0, valid: true };
        form = state; body.replaceChildren();
        const card = section(`${editable ? '编辑' : '新增'}${kind === 'hook' ? '伏笔' : '编年史'}`), fields = grid(card);
        const title = field(fields, '标题', entry?.title ?? ''); title.maxLength = 120;
        const gameTime = field(fields, '剧情时间（可选）', initialTimeText); gameTime.maxLength = 160;
        const actors = field(fields, '关联人物（逗号分隔，可选）', entry?.actors?.join('，') ?? '');
        let hookStatus, remindAfter;
        if (kind === 'hook') {
            hookStatus = select(fields, '伏笔状态', Object.entries(STATUSES), editable ? entry.status : 'open');
            remindAfter = field(fields, '经过多少楼层后提醒（可选）', entry?.remindAfter ?? ''); remindAfter.type = 'number'; remindAfter.min = 1; remindAfter.max = 100000; remindAfter.step = 1;
        }
        const bodyInput = field(fields, kind === 'hook' ? '伏笔内容' : '编年史正文', entry?.body ?? '', true); bodyInput.maxLength = 60000;
        const sourceCard = section('绑定来源', card);
        sourceCard.append(make('p', `目前加载 ${chat.length} 个楼层，楼层号从 1 开始。来源正文会随保存一起留档。`, 'amin-help'));
        const bind = checkbox(sourceCard, '绑定当前聊天的来源楼层', editable ? !!entry.sources : chat.length > 0); bind.disabled = chat.length === 0;
        const range = grid(sourceCard), start = field(range, '起始楼层', editable && entry.sources ? entry.sources.start + 1 : latestFloor), end = field(range, '结束楼层', editable && entry.sources ? entry.sources.end + 1 : latestFloor);
        for (const input of [start, end]) { input.type = 'number'; input.min = 1; input.max = Math.max(1, chat.length); input.step = 1; }
        const sourcePreview = make('pre'); sourcePreview.hidden = true; sourceCard.append(sourcePreview);
        const reflectRange = () => { range.hidden = !bind.checked; sourcePreview.hidden = true; };
        bind.addEventListener('change', reflectRange); reflectRange();
        const rangeValues = () => { if (!bind.checked) throw Error('请先勾选绑定来源楼层'); return { start: Number(start.value) - 1, end: Number(end.value) - 1 }; };
        button(toolbar(sourceCard), '查看所选来源', () => {
            const context = api.check(token), values = rangeValues(), source = sourceFromRange(context.chat, values.start, values.end);
            sourcePreview.textContent = source.messages.map(message => `第 ${message.index + 1} 楼 · ${message.name}\n${message.text}`).join('\n\n'); sourcePreview.hidden = false;
        });
        const sourceNote = field(sourceCard, '来源备注（可选）', editable ? entry.sourceNote : copy ? `复制自档案「${entry.title}」。请核对本分支来源。` : '', true); sourceNote.maxLength = 1000;
        const reference = checkbox(card, '启用后续生成引用（当前分支）', editable && entry.enabled);
        card.append(make('p', '保存只收纳资料。勾选引用后，已确认且来源仍有效的条目才会提供给模型；伏笔提醒只显示在应用中。', 'amin-help'));
        let candidate;
        if (kind === 'chronicle') {
            const draftCard = section('AI 整理', card), instruction = field(draftCard, '整理要求（可选）', '', true);
            draftCard.append(make('p', '使用 AI 设置中“剧情档案”的渠道与预设，准确读取上方选定楼层。生成后先预览、采用，再保存。', 'amin-help'));
            const actions = toolbar(draftCard), preview = section('AI 草稿预览', draftCard, 'amin-result amin-stack'); preview.hidden = true;
            candidate = field(preview, 'AI 草稿（可修改）', '', true); candidate.maxLength = 60000;
            button(toolbar(preview), '采用草稿到正文', () => { if (form !== state || !state.valid) throw Error('编辑来源已变化，请重新打开表单'); bodyInput.value = candidate.value; touch(); say('已采用到正文，请核对并点击“保存编年史”。'); });
            const generate = button(actions, '生成编年史草稿', async () => {
                if (controller) throw Error('正在生成，请先取消当前生成');
                if (!state.valid) throw Error('来源已变化，请取消编辑后重新打开');
                api.check(token); const values = rangeValues(), baseline = state.revision, requestController = new AbortController(); controller = requestController;
                cancel.hidden = false; save.disabled = true; preview.hidden = true; say('正在整理所选楼层…', 'busy');
                try {
                    const result = await api.generateDraft(token, { ...values, title: title.value, current: bodyInput.value, instruction: instruction.value, gameTimeText: gameTime.value },
                        { signal: requestController.signal, check: () => { if (disposed || form !== state || baseline !== state.revision || !state.valid) throw Error('编辑内容已变化，旧生成结果已丢弃，请重新生成'); } });
                    if (requestController.signal.aborted || form !== state) return;
                    candidate.value = result; preview.hidden = false; say('草稿已生成，可修改后采用。点击保存才会写入档案。');
                } catch (error) { if (form === state) say(requestController.signal.aborted ? '生成已取消，原正文保持不变。' : error.message, requestController.signal.aborted ? '' : 'error'); }
                finally { if (controller === requestController) controller = null; cancel.hidden = true; save.disabled = !state.valid; }
            }, true);
            const cancel = button(actions, '取消生成', () => { controller?.abort(); }); cancel.hidden = true;
            if (!chat.length) generate.disabled = true;
        }
        const savebar = toolbar(card, 'amin-savebar');
        const save = button(savebar, kind === 'hook' ? '保存伏笔' : '保存编年史', async () => {
            if (controller) throw Error('请先完成或取消生成');
            if (!state.valid) throw Error('来源已变化，请取消编辑后重新打开');
            const context = api.check(token), values = bind.checked ? rangeValues() : null;
            const record = { id: state.id, kind, title: title.value, body: bodyInput.value, actors: actors.value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean),
                enabled: reference.checked, sources: values ? sourceFromRange(context.chat, values.start, values.end) : null,
                sourceNote: sourceNote.value, gameTime: gameTime.value === initialTimeText ? savedClock : null, gameTimeText: gameTime.value,
                ...(kind === 'hook' ? { status: hookStatus.value, remindAfter: remindAfter.value } : {}) };
            await api.save(token, store => change(store, context.chat, editable ? 'update' : 'create', record, token.operationId));
            if (form === state) finish('已保存' + (record.enabled ? '并启用引用。' : '，引用保持关闭。'));
        }, true);
        button(savebar, '取消编辑', () => { stop(); form = null; render(); say('已取消编辑。'); });
        title.focus(); say('编辑中；来源变化或切换聊天会使当前操作失效。');
    }

    function deleteForm(entry) {
        const token = api.capture(); form = { dirty: false, revision: 0, token, valid: true }; body.replaceChildren();
        const card = section('删除档案：' + entry.title);
        card.append(make('p', '删除后，本分支当前楼层及之后不再显示或引用此条目。更早楼层和其他分支的记录保留。'));
        const actions = toolbar(card);
        button(actions, '确认删除', async () => { const ctx = api.check(token); await api.save(token, store => change(store, ctx.chat, 'delete', { id: entry.id }, token.operationId)); finish('档案已删除。'); }, 'amin-danger');
        button(actions, '取消编辑', () => { form = null; render(); });
    }

    function drawEntries() {
        const ctx = api.context(), store = api.read(), entries = inspectEntries(store, ctx?.chat ?? []), tools = toolbar(body);
        button(tools, selected === 'hook' ? '新增伏笔' : '新增编年史', () => openForm(), true);
        button(tools, '刷新', render);
        const controls = grid(body), query = field(controls, '搜索标题、正文或人物', filters.query); query.type = 'search';
        const scope = select(controls, '显示范围', [['current', '当前分支'], ['inactive', '来源变化 / 其他分支'], ['all', '全部保存记录']], filters.scope);
        let status, due;
        if (selected === 'hook') {
            status = select(controls, '状态筛选', [['', '全部状态'], ...Object.entries(STATUSES)], filters.status);
            due = checkbox(controls, '只看已到提醒间隔的伏笔', filters.dueOnly);
        }
        const list = make('div', '', 'amin-stack'); body.append(list);
        function drawList() {
            list.replaceChildren(); const matching = filterEntries(entries, { ...filters, kind: selected });
            if (!matching.length) { list.append(make('p', entries.some(entry => entry.kind === selected) ? '没有匹配条目，试试调整筛选条件。' : selected === 'hook' ? '还没有伏笔。记下一个线索，或先选择它的来源楼层。' : '还没有编年史。选定一段对话后，可以手工记录或让 AI 起草摘要。', 'amin-empty')); return; }
            for (const entry of [...matching].reverse()) {
                const card = section(entry.title, list), labels = [entry.kind === 'hook' ? STATUSES[entry.status] : '已保存', entry.current ? '当前分支' : '原分支记录', entry.enabled && !entry.stale ? '引用已启用' : '不参与引用'];
                if (entry.due) labels.push('已到提醒间隔'); if (entry.gameTimeText) labels.push(entry.gameTimeText);
                card.append(make('p', labels.join(' · '), 'amin-meta'), make('pre', entry.body));
                if (entry.actors.length) card.append(make('p', '关联人物：' + entry.actors.join('、'), 'amin-meta'));
                if (entry.stale) card.append(make('p', entry.staleReason + '；不会附加到生成中。', 'amin-notice'));
                showSources(card, entry); const actions = toolbar(card);
                if (entry.current) {
                    button(actions, '编辑', () => openForm(entry));
                    button(actions, entry.enabled ? '关闭引用' : '启用引用', async () => {
                        const token = api.capture(), context = api.check(token);
                        await api.save(token, s => change(s, context.chat, 'reference', { id: entry.id, enabled: !entry.enabled }, token.operationId));
                        finish(entry.enabled ? '已关闭此条目的引用。' : '已启用此条目的后续生成引用。');
                    });
                    if (entry.kind === 'hook') for (const [state, label] of Object.entries(STATUSES)) if (state !== entry.status) button(actions, '标为' + label, async () => {
                        const token = api.capture(), context = api.check(token);
                        await api.save(token, s => change(s, context.chat, 'update', { ...entry, status: state }, token.operationId)); finish('伏笔已标为' + label + '。');
                    });
                    button(actions, '删除', () => deleteForm(entry), 'amin-danger');
                } else button(actions, '复制内容为本分支新条目', () => openForm(entry, true));
            }
        }
        query.addEventListener('input', () => { filters.query = query.value; drawList(); });
        scope.addEventListener('change', () => { filters.scope = scope.value; drawList(); });
        status?.addEventListener('change', () => { filters.status = status.value; drawList(); });
        due?.addEventListener('change', () => { filters.dueOnly = due.checked; drawList(); }); drawList();
    }

    function drawReferences() {
        const store = api.read(), ctx = api.context(), all = inspectEntries(store, ctx?.chat ?? []), active = all.filter(entry => entry.current && !entry.stale && entry.enabled);
        const card = section(`当前引用 · ${active.length} 条`);
        card.append(make('p', '以下内容会用于当前分支的后续生成。关闭单条引用即可停止附加；来源变动后的记录自动排除。', 'amin-help'));
        if (!api.supported) card.append(make('p', '当前前端缺少聊天提示接口；仍可管理记录、预览和复制。', 'amin-notice'));
        let prompt;
        try { prompt = compile(store, ctx?.chat ?? []); } catch (error) { prompt = error.message; say(prompt, 'error'); }
        card.append(make('pre', prompt || '没有启用引用的有效条目。'));
        if (prompt) button(toolbar(card), '复制引用预览', async () => { const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard; if (!clipboard?.writeText) throw Error('剪贴板不可用，请手动选择预览文字复制'); await clipboard.writeText(prompt); say('已复制引用预览。'); });
    }

    function drawTransfer() {
        const exportCard = section('导出当前分支'), output = field(exportCard, '剧情档案 JSON', exportRecords(api.read(), api.context()?.chat ?? []), true); output.readOnly = true;
        exportCard.append(make('p', '导出当前分支仍存在的档案及保存时的来源正文。其他分支与删除历史不包含在导出文件中。', 'amin-help'));
        const exportActions = toolbar(exportCard);
        button(exportActions, '复制 JSON', async () => { const clipboard = doc.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard; if (!clipboard?.writeText) { output.focus(); output.select(); throw Error('剪贴板不可用，已选中文本，请手动复制'); } await clipboard.writeText(output.value); say('已复制当前分支档案。'); });
        const importCard = section('导入到当前聊天'), raw = field(importCard, '粘贴剧情档案 JSON', '', true);
        importCard.append(make('p', '导入先预览，明确保存后才写入。每条导入记录的引用默认关闭，需要重新绑定当前聊天来源才可启用。', 'amin-help'));
        const preview = make('div', '', 'amin-stack'); importCard.append(preview);
        raw.addEventListener('input', () => { preview.replaceChildren(); form = { dirty: !!raw.value.trim(), revision: 0 }; });
        button(toolbar(importCard), '验证并预览导入', () => {
            const records = parseImport(raw.value), token = api.capture(), baseline = raw.value; preview.replaceChildren();
            form = { dirty: true, revision: 0, token, valid: true };
            if (!records.length) throw Error('导入内容没有档案');
            preview.append(make('p', `即将导入 ${records.length} 条；引用全部关闭。`, 'amin-notice'));
            for (const record of records) { const row = section((record.kind === 'hook' ? '伏笔 · ' : '编年史 · ') + record.title, preview); row.append(make('pre', record.body)); }
            button(toolbar(preview), '确认保存导入', async () => {
                if (baseline !== raw.value) throw Error('导入内容已变动，请重新验证');
                const context = api.check(token);
                await api.save(token, store => records.reduce((next, record, index) => change(next, context.chat, 'create', record, token.operationId + ':' + index), store));
                finish(`已导入 ${records.length} 条档案，引用保持关闭。`);
            }, true);
        });
        button(toolbar(importCard), '取消编辑', () => { form = null; render(); say('已取消导入。'); });
    }

    function render() {
        if (disposed) return;
        stop(); form = null; body.replaceChildren(); drawTabs();
        const ctx = api.context(); context.textContent = `剧情档案 · ${ctx?.getCurrentChatId?.() ?? '尚未打开聊天'} · 当前加载 ${ctx?.chat?.length ?? 0} 楼`;
        if (!ctx?.chatMetadata || ctx?.getCurrentChatId?.() == null) { body.append(make('p', '打开一个聊天后，即可管理它的伏笔与编年史。', 'amin-empty')); return; }
        try { if (selected === 'references') drawReferences(); else if (selected === 'transfer') drawTransfer(); else drawEntries(); }
        catch (error) { say(error.message, 'error'); }
    }
    const unsubscribe = api.subscribe(event => {
        if (disposed) return;
        if (event?.type === 'chat') { stop(); form = null; filters.query = ''; filters.status = ''; filters.scope = 'current'; filters.dueOnly = false; render(); say(api.status()); }
        else if (event?.type === 'source' && form) { form.valid = false; stop(); say('来源楼层已变化，当前编辑无法保存。请复制需要保留的草稿，再取消编辑并重新绑定来源。', 'error'); }
        else if (!form && event?.type !== 'prompt') { render(); say(api.status(), event?.error ? 'error' : ''); }
        else if (!form) say(api.status());
    });
    const view = { open() { if (!form) render(); }, dispose() { if (disposed) return; disposed = true; stop(); unsubscribe(); if (ownService) api.dispose(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); render(); say(api.status()); return view;
}
