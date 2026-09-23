import { mountGeneration } from '../generation/view.js';
import { getSharedService } from './service.js';
import { installUnifiedWorldbook, inspectUnifiedWorldbook } from './lorebook.js';
import { uuid } from '../../uuid.js';

const mounted = new WeakMap();
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const values = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const sourceLabel = source => typeof source === 'string' ? source : Number.isInteger(source?.index) ? `第 ${source.index + 1} 楼${Number.isInteger(source.swipe) && source.swipe > 0 ? ` · 第 ${source.swipe + 1} 个候选` : ''}` : '当前聊天';

/** The same page is mounted in the OS workbench and the current-floor workbench. */
export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const document = options.document ?? target.ownerDocument ?? globalThis.document;
    const api = options.api ?? getSharedService();
    const getContext = options.getContext ?? (() => globalThis.SillyTavern.getContext());
    const check = options.check ?? (() => {});
    const worldbook = options.worldbook ?? { install: installUnifiedWorldbook, inspect: inspectUnifiedWorldbook };
    const make = (tag, content = '', className = '') => { const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element; };
    if (document.head && !document.getElementById?.('amin-linkage-style')) {
        const style = make('link'); style.id = 'amin-linkage-style'; style.rel = 'stylesheet'; style.href = new URL('../../ui-linkage.css', import.meta.url).href; document.head.append(style);
    }
    const page = make('section', '', 'amin-page amin-app-page amin-linkage amin-stack');
    const context = make('div', '', 'amin-context'), notice = make('p', '', 'amin-notice');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const settingsPanel = make('section', '', 'amin-card amin-stack'), retryPanel = make('section', '', 'amin-stack');
    const reviewPanel = make('section', '', 'amin-stack'), suggestionsPanel = make('section', '', 'amin-card amin-stack');
    const promptPanel = make('details', '', 'amin-card amin-stack'), referencesPanel = make('details', '', 'amin-card amin-stack');
    const manualPanel = make('details', '', 'amin-card amin-stack');
    page.append(context, notice, retryPanel, reviewPanel, settingsPanel, suggestionsPanel, promptPanel, referencesPanel, manualPanel); target.append(page);
    const generationView = mountGeneration(page, { joint: true, getContext, document, service: options.generationService, ai: options.ai });
    let disposed = false, unavailable = false, localBusy = false, message = '', failed = false;
    let lastServiceStatus = '';
    let saved = null, draft = null, settingsDirty = false, moduleRows = [], inputNodes = [], draftNotice, saveButton;
    let promptValue, promptStatus, worldbookStatus, installButton, inspectButton, pasted = '';
    let moduleControls = [], modeControl, extraControl;
    let modulesSignature = '';
    let promptCache = '', promptError = '', worldbookTemplate = null, worldbookMessage = '尚未检查当前聊天的绑定世界书。';
    let manualFrom = '', manualTo = '', manualLabel = '';

    const busy = () => localBusy || api.busy();
    const locked = () => unavailable || busy() || api.dirty() || !!api.preview();
    function say(value, error = false) { message = value; failed = error; notice.textContent = value; notice.dataset.state = error ? 'error' : busy() ? 'busy' : value ? 'success' : ''; }
    async function run(task) {
        if (disposed || localBusy) return;
        localBusy = true; message = ''; failed = false; updateLocks();
        try { check(); await task(); }
        catch (error) { say(error?.message ?? String(error), true); }
        finally { localBusy = false; if (!disposed) render(); }
    }
    function button(label, task, { primary = false, lock = 'mutation' } = {}) {
        const element = make('button', label, primary ? 'amin-primary' : ''); element.type = 'button'; element.dataset.linkageLock = lock;
        element.addEventListener('click', () => { if (!element.disabled) return run(task); }); return element;
    }
    function checkbox(label, checked, change, accessible = label) {
        const row = make('label', '', 'amin-check'), input = make('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', accessible);
        input.addEventListener('change', () => { if (!input.disabled) { change(input.checked); markDraft(); } }); row.append(input, make('span', label)); return { row, input };
    }
    function markDraft() {
        settingsDirty = JSON.stringify(draft) !== JSON.stringify(saved);
        if (draftNotice) draftNotice.textContent = settingsDirty ? '设置尚未保存。条目预览和后续生成仍使用已保存的配置。' : '设置已保存到当前聊天。隐藏桌面磁贴不会停用这里的模块。';
        updateModuleStates(); updateLocks();
    }
    function moduleConfig(row) { return draft.modules[row.id] ?? { enabled: row.enabled === true, read: row.read === true, write: row.write === true }; }
    function setModule(row, key, value) {
        const flags = { ...moduleConfig(row), [key]: value };
        if (key === 'read' && !value) flags.write = false;
        if (key === 'write' && value) flags.read = true;
        if (row.id === 'dice' || row.writable === false) flags.write = false;
        draft.modules[row.id] = flags;
    }
    function updateModuleStates() {
        for (const controls of moduleControls) {
            const current = moduleConfig(controls.module);
            controls.enabled.checked = current.enabled === true; controls.read.checked = current.read === true; controls.write.checked = current.write === true;
            controls.state.textContent = (!current.enabled ? '未加入联动' : `${current.read ? '提供资料' : '不提供资料'} · ${current.write ? '允许更新' : '禁止更新'}`) + (!controls.module.available ? ' · 当前尚无资料' : '');
        }
    }
    function updateLocks() {
        const block = locked(); page.setAttribute('aria-busy', String(busy()));
        for (const element of page.querySelectorAll?.('[data-linkage-lock]') ?? []) {
            const lock = element.dataset.linkageLock;
            element.disabled = lock === 'busy' ? busy() || unavailable : lock === 'confirm' ? busy() || unavailable || api.dirty() || !api.preview() : block || (lock === 'links' && settingsDirty);
        }
        for (const input of inputNodes) input.disabled = block;
        for (const controls of moduleControls) {
            const current = moduleConfig(controls.module);
            controls.enabled.disabled = block;
            controls.read.disabled = controls.write.disabled = block || !current.enabled;
            if (controls.module.id === 'dice' || controls.module.writable === false) controls.write.disabled = true;
        }
        if (saveButton) saveButton.disabled = block || !settingsDirty;
        if (installButton) installButton.disabled = block || settingsDirty || !saved?.enabled;
        if (promptStatus) promptStatus.textContent = settingsDirty ? '正在显示已保存设置生成的条目；先保存设置，再更新世界书。' : promptError || (saved?.enabled ? `${worldbookTemplate === null ? '当前聊天动态内容；检查绑定世界书后可合并条目手写前后文' : '已合并上次检查的世界书前后文；在世界书中修改后请重新检查'} · ${promptCache.length} 字符。` : '联动总开关已关闭，当前不会提供联动资料或接受模型更新。');
    }
    function renderSettings() {
        settingsPanel.replaceChildren(make('h3', '联动范围与更新权限'), make('p', '根据本聊天实际使用的模块组装一份更新规则。应用资料使用稳定 ID 相互引用；关闭模块不会删除已有记录。', 'amin-meta'));
        inputNodes = []; moduleControls = [];
        const enabled = checkbox('启用统一联动更新', draft.enabled === true, value => { draft.enabled = value; }); inputNodes.push(enabled.input); settingsPanel.append(enabled.row);
        const modeRow = make('label', '', 'amin-field'); modeControl = make('select'); modeControl.setAttribute('aria-label', '更新处理方式');
        for (const [value, label] of [['review', '预览后确认'], ['auto', '校验通过后自动应用']]) { const option = make('option', label); option.value = value; modeControl.append(option); }
        modeControl.value = draft.mode === 'auto' ? 'auto' : 'review'; modeControl.addEventListener('change', () => { draft.mode = modeControl.value; markDraft(); }); inputNodes.push(modeControl);
        modeRow.append(make('span', '更新处理方式'), modeControl, make('small', '默认先预览。自动模式也会检查权限、引用和数据格式；未通过的更新不会部分写入。')); settingsPanel.append(modeRow);
        const modules = make('div', '', 'amin-linkage-modules');
        for (const module of moduleRows) {
            const current = moduleConfig(module), card = make('section', '', 'amin-linkage-module amin-stack'); card.dataset.module = module.id;
            const state = make('p', '', 'amin-meta'); card.append(make('h4', module.label || module.id), state);
            if (!module.available) card.append(make('p', module.reason || (['status','map'].includes(module.id) ? '可先启用联动；世界状态字段和地图需要先在对应应用中初始化。' : '尚无资料，可先启用；允许更新后可通过统一更新建立支持的新记录。'), 'amin-meta'));
            const controls = make('div', '', 'amin-linkage-permissions');
            const enabled = checkbox('启用此模块', current.enabled === true, value => setModule(module, 'enabled', value), `${module.label || module.id} · 启用此模块`);
            const read = checkbox('提供资料给模型', current.read === true, value => setModule(module, 'read', value), `${module.label || module.id} · 提供资料给模型`);
            const write = checkbox('允许模型更新', current.write === true, value => setModule(module, 'write', value), `${module.label || module.id} · 允许模型更新`);
            controls.append(enabled.row, read.row, write.row); card.append(controls); modules.append(card); moduleControls.push({ module, state, enabled: enabled.input, read: read.input, write: write.input });
            if (module.id === 'dice' || module.writable === false) card.append(make('p', '此模块仅提供已记录的结果，模型不能改写骰点。', 'amin-meta'));
        }
        settingsPanel.append(modules,make('p','允许模型更新时会同时提供当前资料；取消提供资料也会关闭更新权限。','amin-meta'));
        const rulesRow = make('label', '', 'amin-field'); extraControl = make('textarea'); extraControl.rows = 5; extraControl.maxLength = 40000; extraControl.value = draft.extraRules ?? ''; extraControl.setAttribute('aria-label', '额外联动规则');
        extraControl.placeholder = '例如：只有正文明确发生的变化才能更新；传闻不得直接写成已确认事实。';
        extraControl.addEventListener('input', () => { draft.extraRules = extraControl.value; markDraft(); }); inputNodes.push(extraControl);
        rulesRow.append(make('span', '额外联动规则'), extraControl, make('small', '随当前聊天保存。自动刷新统一条目时保留；不能越过上面的更新权限和数据校验。')); settingsPanel.append(rulesRow);
        draftNotice = make('p', '', 'amin-meta');
        saveButton = button('保存联动设置', async () => {
            await api.saveSettings(clone(draft)); saved = clone(api.settings()); draft = clone(saved); draft.modules ??= {}; settingsDirty = false;
            renderSettings(); refreshPrompt(); say('联动设置已保存。展开统一条目可查看当前内容。');
        }, { primary: true });
        const reset = button('放弃未保存修改', () => { saved = clone(api.settings()); draft = clone(saved); draft.modules ??= {}; settingsDirty = false; renderSettings(); say('已恢复当前聊天中保存的联动设置。'); });
        const actions = make('div', '', 'amin-toolbar'); actions.append(saveButton, reset); settingsPanel.append(draftNotice, actions); markDraft();
    }
    function refreshPrompt() {
        try { const dynamic = text(api.prompt()); promptCache = dynamic && worldbookTemplate !== null ? worldbookTemplate.replace('{{amin_os_linkage}}', () => dynamic) : dynamic; promptError = ''; }
        catch (error) { promptCache = ''; promptError = error?.message ?? String(error); }
        if (promptValue) promptValue.value = promptCache;
    }
    function createPromptPanel() {
        promptPanel.append(make('summary', '统一世界书条目与预览'), make('p', '统一条目在生成时展开为当前聊天允许读取的资料、更新格式和规则。下方预览使用已保存的配置；点击检查绑定世界书后，还会合并条目中手写的前后文。', 'amin-meta'));
        promptStatus = make('p', '', 'amin-meta'); promptValue = make('textarea', '', 'amin-linkage-code'); promptValue.readOnly = true; promptValue.rows = 14; promptValue.setAttribute('aria-label', '统一条目预览内容');
        const actions = make('div', '', 'amin-toolbar');
        actions.append(button('刷新条目预览', () => { refreshPrompt(); if (promptError) throw Error(promptError); say('已刷新统一条目预览。'); }, { lock: 'busy' }), button('复制条目预览', async () => {
            refreshPrompt(); if (promptError) throw Error(promptError); if (!promptCache) throw Error('当前没有可复制的条目内容。');
            const clipboard = options.clipboard ?? document.defaultView?.navigator?.clipboard ?? globalThis.navigator?.clipboard;
            if (clipboard?.writeText) { try { await clipboard.writeText(promptCache); say('已复制统一条目完整内容。'); return; } catch { /* The selected preview is a usable fallback in restricted webviews. */ } }
            promptPanel.open = true; promptValue.focus(); promptValue.select?.(); say('请从已选中的预览文本中手动复制。');
        }, { lock: 'busy' }));
        worldbookStatus = make('p', worldbookMessage, 'amin-meta');
        inspectButton = button('检查绑定世界书', async () => {
            worldbookTemplate=null;refreshPrompt();
            const result = await worldbook.inspect({ getContext }); check(); worldbookMessage = `世界书「${result.name}」：` + (result.message || (result.exists ? '已安装统一条目' : '尚未安装统一条目'));
            worldbookTemplate=typeof result.content==='string'&&result.content.split('{{amin_os_linkage}}').length===2?result.content:null;refreshPrompt();
            worldbookStatus.textContent = worldbookMessage; say(worldbookMessage, result.valid === false && result.exists === true);
        }, { lock: 'busy' });
        installButton = button('安装／更新统一条目', async () => {
            if (settingsDirty) throw Error('请先保存联动设置。');
            const result = await worldbook.install({ getContext }); check();
            worldbookMessage = `世界书「${result.name}」：` + (result.message || `${result.action || '已更新'}统一条目（UID ${result.uid}）。`);
            if (result.warning) worldbookMessage += '\n' + result.warning;
            worldbookStatus.textContent = worldbookMessage; say(worldbookMessage, !!result.warning);
        }, { primary: true });
        const worldbookActions = make('div', '', 'amin-toolbar'); worldbookActions.append(inspectButton, installButton);
        promptPanel.append(promptStatus, promptValue, actions, worldbookStatus, worldbookActions, make('p', '世界书只保存统一条目模板，当前聊天资料在本轮生成中展开。再次安装保留条目的停用、位置、触发设置及自定义规则。额外联动规则按聊天保存。', 'amin-meta'));
    }
    function renderReview() {
        reviewPanel.replaceChildren(); const pending = api.preview(); reviewPanel.hidden=!pending;if (!pending) return;
        const card = make('section', '', 'amin-card amin-stack amin-result'); card.append(make('h3', pending.label || '待确认 · 跨应用更新'));
        if (pending.summary) card.append(make('p', Array.isArray(pending.summary) ? pending.summary.join('\n') : text(pending.summary), 'amin-linkage-text'));
        if (pending.source) card.append(make('p', '来源：' + sourceLabel(pending.source), 'amin-meta'));
        const changes = values(pending.changes ?? pending.operations);
        for (const change of changes) {
            const row = make('article', '', 'amin-linkage-change amin-stack'), module = moduleRows.find(item => item.id === change.module);
            row.append(make('h4', [...new Set([module?.label || change.module || '关联资料', change.label || change.action || change.op || '', change.target || ''].filter(Boolean))].join(' · ')));
            if (change.summary) row.append(make('p', text(change.summary), 'amin-linkage-text'));
            if (Object.hasOwn(change, 'before') || Object.hasOwn(change, 'after')) {
                const comparison = make('div', '', 'amin-linkage-comparison');
                for (const [key, label] of [['before', '更新前'], ['after', '更新后']]) { const column = make('div', '', 'amin-stack'); column.append(make('strong', label), make('pre', text(change[key]) || '无', 'amin-linkage-value')); comparison.append(column); }
                const details=make('details');details.append(make('summary','查看更新前后的完整资料'),comparison);row.append(details);
            } else { const content = change.value ?? change.payload ?? change.data ?? change.patch; if (content !== undefined) row.append(make('pre', text(content), 'amin-linkage-value')); }
            if (change.reason) row.append(make('p', '原因：' + change.reason, 'amin-meta')); card.append(row);
        }
        for (const warning of values(pending.warnings)) card.append(make('p', text(warning), 'amin-meta'));
        for (const error of values(pending.errors)) card.append(make('p', text(error), 'amin-notice'));
        const actions = make('div', '', 'amin-toolbar');
        const confirm = button('确认整组更新一次', async () => { await api.confirm(); say('整组关联更新已应用并保存。'); }, { primary: true, lock: 'confirm' });
        if (values(pending.errors).length || pending.valid === false) confirm.dataset.linkageInvalid = 'true';
        actions.append(confirm, button('放弃这组更新', () => { api.discard(); say('已放弃待确认更新，当前资料保持原值。'); }, { lock: 'busy' }));
        card.append(make('p', '本次关联变更作为一组处理。确认前不会写入各应用；请核对人物、物品与数值的对应关系。', 'amin-meta'), actions); reviewPanel.append(card);
    }
    function renderSuggestions() {
        suggestionsPanel.replaceChildren(make('h3', '收到的剧情更新建议'));
        const suggestions = values(api.suggestions());
        if (!suggestions.length) { suggestionsPanel.append(make('p', saved?.enabled ? '暂时没有待查看的更新建议。' : '启用并保存统一联动后，可接收模型返回的更新建议。', 'amin-empty')); return; }
        for (const suggestion of suggestions) {
            const row = make('article', '', 'amin-linkage-suggestion amin-stack');
            row.append(make('strong', sourceLabel(suggestion.source)), make('p', suggestion.label || '一组关联更新', 'amin-meta'));
            const source = make('details'); source.append(make('summary', '查看原始更新内容'), make('pre', text(suggestion.text), 'amin-linkage-value')); row.append(source);
            if (suggestion.error) row.append(make('p', text(suggestion.error), 'amin-meta'));
            row.append(button('校验并预览这组更新', async () => { await api.stageSuggestion(suggestion.id); say('已校验更新建议，请检查整组变更。'); })); suggestionsPanel.append(row);
        }
    }
    function renderReferences() {
        const open = referencesPanel.open; referencesPanel.replaceChildren(make('summary', '跨应用引用检查')); referencesPanel.open = open;
        try {
            const report = api.references(), entities = values(report.entities), links = values(report.links), unresolved = values(report.unresolved);
            const entityName = id => entities.find(item => item.id === id)?.label || id;
            referencesPanel.append(make('p', `${entities.length} 个实体 · ${links.length} 条关联 · ${unresolved.length} 条未解析引用`, 'amin-meta'));
            if (!unresolved.length) referencesPanel.append(make('p', '当前检查未发现未解析引用。', 'amin-empty'));
            else {
                const list = make('ul', '', 'amin-linkage-reference-list');
                for (const item of unresolved) list.append(make('li', typeof item === 'string' ? item : [item.label || item.message || item.reason, item.module, item.fromId || item.sourceId || item.from, item.targetId || item.toId || item.target || item.to].filter(Boolean).map(text).join(' · ') || text(item)));
                referencesPanel.append(list, make('p', '未解析引用会保留原 ID，不会按同名记录自动替换。请到对应应用修正后重新检查。', 'amin-meta'));
            }
            const details = make('details'); details.append(make('summary', '查看已有的条目关联'));
            if (!links.length) details.append(make('p', '当前没有条目间的关联。', 'amin-empty'));
            else {
                const list=make('ul','','amin-linkage-reference-list');
                for(const link of links)list.append(make('li',`${entityName(link.from)} → ${entityName(link.to)}${link.label?' · '+link.label:''}`));
                details.append(list);
            }
            details.append(make('p','由人物归属、穿戴、日程等字段产生的关联，在对应应用中修改。','amin-meta'));referencesPanel.append(details);
            if(typeof api.saveLinks==='function') {
                const manual=make('section','','amin-stack');manual.append(make('h4','手动关联'),make('p','选择两个现有条目，补充它们的关联说明。删除只解除手动关联，不删除原条目。','amin-meta'));
                if(settingsDirty)manual.append(make('p','请先保存或放弃上方的联动设置修改，再编辑手动关联。','amin-meta'));
                const form=make('div','','amin-form-grid');
                const selectEntity=(label,value,onChange)=>{
                    const row=make('label','','amin-field'),select=make('select');select.setAttribute('aria-label',label);select.dataset.linkageLock='links';
                    const placeholder=make('option','请选择条目');placeholder.value='';select.append(placeholder);
                    for(const entity of entities){const option=make('option',`${moduleRows.find(item=>item.id===entity.module)?.label||entity.module||'条目'} · ${entity.label||entity.id}${entity.label&&entity.label!==entity.id?' · '+entity.id:''}`);option.value=entity.id;select.append(option);}
                    select.value=entities.some(item=>item.id===value)?value:'';select.addEventListener('change',()=>onChange(select.value));row.append(make('span',label),select);form.append(row);return select;
                };
                selectEntity('关联来源条目',manualFrom,value=>{manualFrom=value;});selectEntity('关联目标条目',manualTo,value=>{manualTo=value;});
                const labelRow=make('label','','amin-field amin-span-full'),label=make('input');label.type='text';label.value=manualLabel;label.maxLength=200;label.setAttribute('aria-label','关联说明');label.dataset.linkageLock='links';label.addEventListener('input',()=>{manualLabel=label.value;});labelRow.append(make('span','关联说明'),label);form.append(labelRow);manual.append(form);
                manual.append(button('保存新关联',async()=>{
                    if(!manualFrom||!manualTo||!entities.some(item=>item.id===manualFrom)||!entities.some(item=>item.id===manualTo))throw Error('请选择仍然存在的来源和目标条目。');
                    if(!manualLabel.trim())throw Error('请填写关联说明。');
                    const current=api.settings().links??[];await api.saveLinks([...current,{id:options.createId?.()??uuid(),from:manualFrom,to:manualTo,label:manualLabel.trim()}]);manualFrom='';manualTo='';manualLabel='';say('已保存两个条目之间的关联。');
                },{primary:true,lock:'links'}));
                const manualLinks=api.settings().links??[];
                if(!manualLinks.length)manual.append(make('p','还没有手动添加的关联。','amin-empty'));
                for(const link of manualLinks){const row=make('article','','amin-linkage-suggestion amin-stack');row.append(make('p',`${entityName(link.from)} → ${entityName(link.to)}`),make('p',link.label,'amin-meta'));const remove=button('解除手动关联',async()=>{await api.saveLinks((api.settings().links??[]).filter(item=>item.id!==link.id));say('已解除手动关联，原条目仍保留。');},{lock:'links'});remove.setAttribute('aria-label',`解除手动关联：${link.label}`);row.append(remove);manual.append(row);}
                referencesPanel.append(manual);
            }
            referencesPanel.append(button('刷新引用检查', () => { renderReferences(); say('已重新检查跨应用引用。'); }, { lock: 'busy' }));
        } catch (error) { referencesPanel.append(make('p', error?.message ?? String(error), 'amin-notice')); }
    }
    function createManualPanel() {
        manualPanel.append(make('summary', '手动导入更新建议'));
        const input = make('textarea'); input.rows = 6; input.setAttribute('aria-label', '待校验的统一更新内容'); input.placeholder = '粘贴模型返回的统一更新块，再校验并预览。';
        input.addEventListener('input', () => { pasted = input.value; });
        manualPanel.append(input, button('校验并预览粘贴内容', async () => { if (!pasted.trim()) throw Error('请先粘贴更新内容。'); await api.stage(pasted); say('已校验更新内容，请检查整组变更。'); }), make('p', '导入也遵守当前聊天保存的模块权限。粘贴内容不会直接写入应用。', 'amin-meta'));
    }
    function render() {
        if (disposed) return;
        try {
            check(); const current = api.settings(); moduleRows = api.modules(); unavailable = false;
            const nextModulesSignature=JSON.stringify(moduleRows), modulesChanged=nextModulesSignature!==modulesSignature;modulesSignature=nextModulesSignature;
            const changed = !saved || JSON.stringify(current) !== JSON.stringify(saved);
            if (!saved || (changed && !settingsDirty)) { saved = clone(current); draft = clone(current); draft.modules ??= {}; settingsDirty = false; renderSettings(); }
            else if (changed) { saved = clone(current); markDraft(); }
            else if(modulesChanged)renderSettings();
            context.textContent = `统一联动 · 当前聊天 · ${current.enabled ? current.mode === 'auto' ? '自动应用' : '预览后确认' : '尚未启用'} · 已选 ${moduleRows.filter(row => row.enabled).length} 个模块`;
            refreshPrompt(); renderReview(); renderSuggestions(); renderReferences(); retryPanel.replaceChildren();retryPanel.hidden=!api.dirty();
            if (api.dirty()) retryPanel.append(make('h3', '保存尚未完成'), make('p', '已确认变更保留在当前聊天内存中。重试只保存这组结果，不再执行一次更新。', 'amin-meta'), button('重试保存整组更新', async () => { await api.retrySave(); say('此前确认的整组更新已保存。'); }, { primary: true, lock: 'busy' }));
            const status = api.status(), serviceStatus = typeof status === 'string' ? status : status?.message || '';
            if(serviceStatus!==lastServiceStatus){lastServiceStatus=serviceStatus;if(!localBusy){message='';failed=false;}}
            if (!message) { notice.textContent = serviceStatus; notice.dataset.state = busy() ? 'busy' : ''; }
            else say(message, failed);
        } catch (error) { unavailable = true; context.textContent = '统一联动 · 当前聊天不可用'; say(error?.message ?? String(error), true); }
        updateLocks();
        for (const element of page.querySelectorAll?.('[data-linkage-invalid]') ?? []) element.disabled = true;
    }
    createPromptPanel(); createManualPanel(); const unsubscribe = api.subscribe(render); render();
    const view = { element: page, open(section) {
        if(disposed)return;render();
        if(section==='prompt'){promptPanel.open=true;promptPanel.scrollIntoView?.({block:'start'});promptValue.focus?.({preventScroll:true});}
        else if(section==='updates')(api.preview()?reviewPanel:suggestionsPanel).scrollIntoView?.({block:'start'});
    }, dispose() { if (disposed) return; disposed = true; generationView.dispose(); unsubscribe?.(); page.remove(); mounted.delete(target); } };
    mounted.set(target, view); return view;
}
