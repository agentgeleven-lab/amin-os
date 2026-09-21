// 文风转换 (stylewriter) pane app. Mounts once per target; every async result is guarded by
// chat identity + content/mode/preset stamps so late results are never mis-applied.
import { styleLibrary, contentLibrary, contentInstruction } from '../reply/writing-library.js';
import { mountContentStyles } from '../reply/content-styles-view.js';
import { getAI } from '../../ai/service.js';
import { inputElement, waitForResult, rewriteText, writeToInput } from './generator.js';
import { MODES, chatIdentity, presetStamp, buildRequest, referenceSamples, fillGuard, normalizeResult } from './model.js';

const mounted = new WeakMap();

export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const doc = options.document ?? globalThis.document;
    const getContext = options.getContext ?? (() => globalThis.SillyTavern?.getContext?.());
    const settingsContext=options.settingsContext??getContext;
    const referenceStamp=ctx=>JSON.stringify(referenceSamples(ctx??{}));
    const aiProvider = options.ai ?? (() => getAI());
    const generateImpl = options.generate ?? rewriteText;
    const make = options.makeElement ?? (tag => doc.createElement(tag));
    const node = (tag, text, cls) => { const n = make(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    const root = node('div', null, 'amin-page amin-stylewriter');
    root.id = options.instanceId ?? 'stylewriter-app';
    const intro = node('div', null, 'amin-context');
    intro.append(node('h2', '文风转换'), node('p', '把输入框里的原文改写成目标文风：可参考当前聊天的文风，或使用保存的自定义文风预设。默认只改表达，不改事实、指代、意图与视角，不替你续写或代替其他角色行动。'));
    const identityNote = node('p');
    intro.append(identityNote);

    const modeTabs = node('nav', null, 'amin-tabs');
    modeTabs.setAttribute('aria-label', '文风模式');
    const modeHelp = node('p');
    const presetCard = node('section', null, 'amin-card');
    const presetRow = node('label');
    presetRow.append(node('span', '文风预设'));
    const presetSelect = node('select');
    presetSelect.setAttribute('aria-label', '文风预设');
    presetRow.append(presetSelect);
    const presetToolbar = node('div', null, 'amin-toolbar');
    const editor = node('details', null, 'amin-card');
    editor.append(node('summary', '编辑预设'));
    const nameRow = node('label');
    nameRow.append(node('span', '预设名称（必填，40 字内）'));
    const nameInput = node('input');
    nameInput.maxLength = 40;
    nameInput.setAttribute('aria-label', '预设名称');
    nameRow.append(nameInput);
    const descRow = node('label');
    descRow.append(node('span', '文风说明（必填；描述用词、句式、节奏与排版，不要填写 API 密钥，不限长度）'));
    const descArea = node('textarea');
    descArea.rows = 5;
    descArea.setAttribute('aria-label', '文风说明');
    descRow.append(descArea);
    const editorNote = node('p');
    const editorToolbar = node('div', null, 'amin-toolbar');
    const undoRow = node('div', null, 'amin-toolbar');
    undoRow.hidden = true;
    editor.append(nameRow, descRow, editorToolbar, editorNote, undoRow);
    presetCard.append(presetRow, presetToolbar, editor);

    const sourceCard = node('section', null, 'amin-card');
    const sourceRow = node('label');
    sourceRow.append(node('span', '原文（可编辑；不会自动发送，也不会硬截断）'));
    const sourceArea = node('textarea');
    sourceArea.rows = 6;
    sourceArea.setAttribute('aria-label', '原文');
    sourceRow.append(sourceArea);
    const sourceToolbar = node('div', null, 'amin-toolbar');
    sourceCard.append(sourceRow, sourceToolbar);

    const actions = node('div', null, 'amin-toolbar');
    const status = node('p', '填写原文后开始转换。', 'amin-notice');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const resultCard = node('section', null, 'amin-card');
    resultCard.hidden = true;
    resultCard.append(node('h3', '转换结果（可编辑）'));
    const resultMeta = node('p');
    const resultArea = node('textarea');
    resultArea.rows = 8;
    resultArea.setAttribute('aria-label', '转换结果');
    const resultToolbar = node('div', null, 'amin-toolbar');
    resultCard.append(resultMeta, resultArea, resultToolbar);

    root.append(intro, modeTabs, modeHelp, presetCard, sourceCard, actions, status, resultCard);
    target.append(root);

    const say = text => { status.textContent = text; };
    const button = (parent, label, fn, primary = false) => {
        const b = node('button', label, primary ? 'amin-primary' : '');
        b.type = 'button';
        b.addEventListener('click', () => { try { fn(); } catch (error) { say(error.message); } });
        parent.append(b);
        return b;
    };

    let store;
    try { store = options.store ?? styleLibrary(settingsContext); } catch (error) { say(error.message); }
    let mode = store?.mode() ?? 'chat';
    let selectedId=store?.selectedId()??'',contentMode=store?.contentMode()??'none';
    let identity = '';
    let revision = 0, invalidateReason = '', controller = null, busy = false, disposed = false;
    let editingId = store?.selectedId() ?? '';
    let drafts = new Map();
    let undoToken = null, armTimer = null, armedDelete = null;
    let fillBase = null, undoFillState = null, running = null;
    const perChat = new Map();
    const chatState = () => { if (!perChat.has(identity)) perChat.set(identity, { source: '', result: '', meta: null }); return perChat.get(identity); };

    const draftOwner = {};
    const modeButtons = new Map();
    for (const item of MODES) {
        const b = node('button', item.name);
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => setMode(item.id));
        modeTabs.append(b);
        modeButtons.set(item.id, b);
    }
    const newButton = button(presetToolbar, '新建预设', () => { editingId = 'new'; drafts.set('new', drafts.get('new') ?? { name: '', description: '' }); disarmDelete(); editor.open = true; renderPresetEditor(); say('正在新建预设：填写名称与文风说明后保存。'); });
    const deleteButton = button(presetToolbar, '删除预设', deletePreset, false);
    const saveButton = button(editorToolbar, '保存修改', savePreset, true);
    const saveAsButton = button(editorToolbar, '另存为新预设', saveAsPreset);
    const discardButton = button(editorToolbar, '放弃修改', discardPreset);
    const undoButton = button(undoRow, '撤销删除', undoDelete);
    const readButton = button(sourceToolbar, '读取聊天输入框', readInput);
    const clearButton = button(sourceToolbar, '清空原文', () => { sourceArea.value = ''; sourceChanged('已清空原文。'); });
    const convertButton = button(actions, '转换文风', () => convert(), true);
    const cancelButton = button(actions, '取消', () => { if (controller) { controller.abort(new Error('已取消转换；底层请求可能仍在运行。')); say('已取消转换；底层请求可能仍在运行。'); } });
    cancelButton.hidden = true;
    const retryButton = button(actions, '重试', () => convert());
    retryButton.hidden = true;
    const copyButton = button(resultToolbar, '复制结果', copyResult);
    const fillButton = button(resultToolbar, '填回聊天输入框', fillBack);
    const undoFillButton = button(resultToolbar, '撤销填回', undoFill);
    undoFillButton.hidden = true;

    presetSelect.addEventListener('change', () => {
        const id = presetSelect.value;
        if (!id) { say('当前没有预设：请新建一个文风预设。'); renderPresetOptions(); return; }
        try { store.select(id); } catch (error) { say(error.message); renderPresetOptions(); return; }
        selectedId=id;renderPresetOptions();
        editingId = id; // switching always focuses the chosen preset; a leftover "new" draft stays in drafts
        disarmDelete();
        renderPresetEditor();
        reset(`预设已切换到「${store.get(id)?.name ?? id}」，本次转换已取消。`);
    });
    // Unsaved preset edits live in a per-preset draft map: switching presets, chats or hiding
    // the pane never drops them silently; only 保存 or 放弃修改 clears a draft.
    const captureDraft = () => {
        if (!editingId) return;
        drafts.set(editingId, { name: nameInput.value, description: descArea.value });
        const current=store.get(editingId);
        store.setDraft(draftOwner,editingId,!current||current.name!==nameInput.value||current.description!==descArea.value);
        disarmDelete();
        // Editing the preset a custom-mode run is based on invalidates that run: the late
        // result must never land while the editor content differs from what was captured.
        if (controller && mode === 'custom' && editingId === presetSelect.value) {
            reset('预设已被修改，本次结果已丢弃；请重新转换。');
            say('预设已修改：等待中的结果将丢弃，请重新转换。');
        }
    };
    nameInput.addEventListener('input', captureDraft);
    descArea.addEventListener('input', captureDraft);
    sourceArea.addEventListener('input', () => sourceChanged());
    resultArea.addEventListener('input', () => { const state = chatState(); state.result = resultArea.value; });
    const unsubscribe = store?.subscribe((error,event) => {
        if(event?.draftOwner===draftOwner)return;
        if(controller&&mode==='custom'&&(presetStamp(store.get(selectedId))!==running?.presetMark||store.hasDraft(selectedId)))reset('文风设置或编辑已变化，本次转换已取消。');
        renderPresetOptions();
        renderPresetEditor();
        if (error) {const current=store.get(editingId),draft=drafts.get(editingId);if(draft)store.setDraft(draftOwner,editingId,!current||draft.name!==current.name||draft.description!==current.description);mode=store.mode();selectedId=store.selectedId();contentMode=store.contentMode();renderPresetOptions();renderModes();reset('文风设置保存失败，本次转换已取消。');say(`文风预设保存失败（${error.message || error}）：已恢复到上次成功保存的预设列表；未保存的修改仍保留在编辑器中。`);}
    });

    const contentHost=node('div');
    sourceCard.append(contentHost);
    const contentControls=mountContentStyles(contentHost, {
        document:doc, library:options.contentLibrary??contentLibrary(settingsContext),
        getSelection:()=>contentMode,
        setSelection:id=>{store?.setContentMode(id);contentMode=id;},
        onChange:()=>reset('内容风格已变化，本次转换已取消。'),
    });

    function touchDraft() { const state = chatState(); state.source = sourceArea.value; }
    // Any source change (typing, clear, re-read) invalidates a running conversion: a late
    // result must never land on a source the user can no longer see as it was captured.
    function sourceChanged(note = '') {
        touchDraft();
        if (controller) { reset('原文已被修改，本次结果已丢弃；请重新转换。'); say(`${note}原文已修改：等待中的结果将丢弃，请重新转换。`); }
        else if (note) say(note);
    }
    function stale(reason) { revision++; invalidateReason = reason; }
    function reset(reason) { revision++; invalidateReason = reason; if (controller) { controller.abort(new Error(reason)); say(reason); } }
    function setBusy(value) { busy = value; convertButton.disabled = value; convertButton.textContent = value ? '转换中…' : '转换文风'; cancelButton.hidden = !value; if (value) retryButton.hidden = true; }

    function setMode(next) {
        if (next === mode || !store) return;
        try { store.setMode(next); } catch(error) { say(error.message); return; }
        mode = next;
        renderModes();
        reset(next === 'chat' ? '已切换为参考当前聊天文风，本次转换已取消。' : '已切换为自定义文风，本次转换已取消。');
    }
    function renderModes() {
        for (const item of MODES) modeButtons.get(item.id)?.setAttribute('aria-pressed', String(item.id === mode));
        presetCard.hidden = mode !== 'custom';
        modeHelp.textContent = mode === 'none' ? '不额外指定文风：保持原文表达习惯，只改善行文清晰度；不读取聊天或世界书。' : mode === 'chat'
            ? '参考模式：仅读取当前已加载聊天最近 16 条非系统正文（每条完整传递，更早消息不包含）；不读取世界书、人设或群组设定。'
            : '自定义模式：只使用你选择的文风预设；请求中不包含任何聊天内容。';
    }
    function renderPresetOptions() {
        if (!store) return;
        const list = store.list();
        presetSelect.replaceChildren();
        if (!list.length) { selectedId='';const o = node('option', '（尚无预设，请新建）'); o.value = ''; presetSelect.append(o); return; }
        for (const preset of list) { const o = node('option', preset.name); o.value = preset.id; presetSelect.append(o); }
        if(!store.get(selectedId))selectedId=store.selectedId();
        presetSelect.value = selectedId;
    }
    function renderPresetEditor() {
        if (!store) return;
        // a preset that vanished keeps its editor slot only while a draft still holds the
        // user's content (e.g. a save the host rejected) — the editor never eats edits
        if (editingId !== 'new' && !store.get(editingId) && !drafts.has(editingId)) editingId = selectedId || 'new';
        const isNew = editingId === 'new' || !store.get(editingId);
        const preset = store.get(editingId);
        const draft = drafts.get(editingId);
        nameInput.value = draft?.name ?? preset?.name ?? '';
        descArea.value = draft?.description ?? preset?.description ?? '';
        const dirty = isNew ? Boolean(draft && (draft.name.trim() || draft.description.trim())) : Boolean(draft && preset && (draft.name !== preset.name || draft.description !== preset.description));
        editorNote.textContent = isNew
            ? '新预设尚未保存；未保存内容会保留在界面中，不会被自动清除。'
            : dirty ? '有未保存的修改；切换预设或收起面板都不会丢失，可保存或放弃。' : '修改名称或文风说明后保存；预设保存在本机酒馆设置中，不包含任何密钥。';
        deleteButton.hidden = isNew;
        saveButton.textContent = isNew ? '保存新预设' : '保存修改';
    }
    function savePreset() {
        const draft = { name: nameInput.value, description: descArea.value };
        const preset = store.save(draft, editingId !== 'new' && store.get(editingId) ? editingId : undefined);
        drafts.delete(editingId);
        store.setDraft(draftOwner,editingId,false);
        selectedId=preset.id;editingId = preset.id;
        // keep a clean copy: if the host later rejects the save and the list rolls back,
        // the editor still holds exactly what the user saved
        drafts.set(preset.id, { name: preset.name, description: preset.description });
        // re-render after editingId settles: the subscribe render ran mid-save with stale state
        renderPresetOptions();
        renderPresetEditor();
        disarmDelete();
        say(`文风预设「${preset.name}」已保存。`);
        reset(`预设「${preset.name}」已保存，本次转换已取消。`);
    }
    function saveAsPreset() {
        const draft = { name: nameInput.value, description: descArea.value };
        const preset = store.save(draft);
        drafts.delete(editingId);
        store.setDraft(draftOwner,editingId,false);
        selectedId=preset.id;editingId = preset.id;
        drafts.set(preset.id, { name: preset.name, description: preset.description });
        renderPresetOptions();
        renderPresetEditor();
        disarmDelete();
        say(`已另存为新预设「${preset.name}」。`);
        reset(`预设「${preset.name}」已保存，本次转换已取消。`);
    }
    function discardPreset() {
        drafts.delete(editingId);
        store.setDraft(draftOwner,editingId,false);
        editingId = selectedId || 'new';
        renderPresetOptions();
        renderPresetEditor();
        disarmDelete();
        say('已放弃未保存的预设修改。');
    }
    // The delete confirmation is bound to one concrete preset snapshot; switching, creating
    // or editing anything disarms it, so a stale "confirm" can never delete another preset.
    function disarmDelete() {
        armedDelete = null;
        clearTimeout(armTimer);
        deleteButton.textContent = '删除预设';
        deleteButton.className = '';
    }
    function deletePreset() {
        if (editingId === 'new' || !store.get(editingId)) { disarmDelete(); say('请先选择要删除的预设。'); return; }
        const preset = store.get(editingId);
        const stamp = presetStamp(preset);
        if (!armedDelete || armedDelete.id !== preset.id || armedDelete.stamp !== stamp) {
            armedDelete = { id: preset.id, stamp };
            deleteButton.textContent = `确认删除「${preset.name}」？`;
            deleteButton.className = 'danger';
            clearTimeout(armTimer);
            armTimer = setTimeout(disarmDelete, 5000);
            say('再次点击“确认删除”才会删除；删除后可撤销。');
            return;
        }
        disarmDelete();
        const deletedId=editingId, deletedDraft=drafts.get(editingId)??null;
        undoToken = store.remove(deletedId);
        undoToken.draft = deletedDraft;
        drafts.delete(deletedId);
        store.setDraft(draftOwner,deletedId,false);
        editingId = selectedId || 'new';
        renderPresetOptions();
        renderPresetEditor();
        undoButton.textContent = `撤销删除「${undoToken.preset.name}」`;
        undoRow.hidden = false;
        say(`已删除预设「${undoToken.preset.name}」。`);
        reset('预设已删除，本次转换已取消。');
    }
    function undoDelete() {
        if (!undoToken) { say('没有可撤销的删除。'); return; }
        const token = undoToken;
        try { store.restore(token); } catch (error) { say(error.message); return; }
        if (token.draft) {drafts.set(token.preset.id, token.draft);store.setDraft(draftOwner,token.preset.id,token.draft.name!==token.preset.name||token.draft.description!==token.preset.description);}
        selectedId=token.preset.id;editingId = token.preset.id;
        undoToken = null;
        undoRow.hidden = true;
        renderPresetOptions();
        renderPresetEditor();
        say('已恢复刚删除的预设。');
        reset('预设已恢复，本次转换已取消。');
    }
    function readInput() {
        syncChat(); // a context switch without CHAT_CHANGED must not write into the old chat's draft
        const input = inputElement(doc);
        sourceArea.value = input.value;
        sourceChanged(input.value.trim() ? '已读取聊天输入框内容到原文。' : '聊天输入框当前为空。');
    }
    async function copyResult() {
        const text = resultArea.value;
        if (!text.trim()) { say('没有可复制的结果。'); return; }
        try {
            if (!doc.defaultView?.navigator?.clipboard?.writeText) throw Error('clipboard unavailable');
            await doc.defaultView.navigator.clipboard.writeText(text);
            say('结果已复制到剪贴板。');
        } catch {
            resultArea.focus?.();
            resultArea.select?.();
            say('剪贴板不可用：已选中结果全文，可按 Ctrl+C 复制。');
        }
    }

    async function convert() {
        if (busy || disposed) return;
        let ctx;
        try{syncChat();ctx=getContext();}catch(error){reset(error.message);say(error.message);return;}
        const service = aiProvider?.();
        if (!service) { say('文风转换依赖共享 AI 设置：请先在“AI 设置”中配置并启用渠道。'); return; }
        let snapshot;
        try { snapshot = service.capture('stylewriter'); } catch (error) { say(error.message); return; }
        let request;
        try {
            contentControls.assertSaved();
            if (mode === 'custom') {
                if (!store) throw Error('预设存储不可用：请刷新页面后重试。');
                const preset=store.get(presetSelect.value);
                if(store.hasDraft(preset?.id))throw Error('请先保存或放弃所选文风预设的修改。');
                if(editingId==='new'||(!store.get(editingId)&&drafts.has(editingId))||(editingId===preset?.id&&(nameInput.value!==preset.name||descArea.value!==preset.description)))throw Error('请先保存文风预设或放弃未保存的修改，再开始转换；不会静默使用旧文风。');
                request = buildRequest({ mode, source: sourceArea.value, preset });
            }
            else request = buildRequest({ mode, source: sourceArea.value, samples: mode==='chat'?referenceSamples(ctx ?? {}):undefined });
            const theme=contentControls.selection();
            request.systemPrompt += contentInstruction(theme,true);
            request.meta.contentStyle=theme.name;
            if(theme.id!=='none')request.meta.label+=` · 内容风格「${theme.name}」`;
        } catch (error) { say(error.message); retryButton.hidden = false; return; }
        let input = null;
        try { const inputNode = inputElement(doc); input = { node: inputNode, value: inputNode.value }; } catch { input = null; }
        touchDraft();
        const ticket = ++revision;
        invalidateReason = '';
        const captured = {
            ticket,
            source: sourceArea.value,
            identity: chatIdentity(ctx ?? {}),
            contentStamp: mode === 'chat' ? referenceStamp(ctx) : '',
            mode,
            presetMark: mode === 'custom' ? presetStamp(store.get(presetSelect.value)) : '',
            input,
            request,
        };
        const current = new AbortController();
        controller = current;
        running = captured;
        // Fill authorization belongs to an applied result, never to a running request: a
        // failed rerun keeps the previous result's original guard instead of granting a new one.
        setBusy(true);
        say(`转换中… ${request.meta.label}`);
        try {
            const raw = await waitForResult(generateImpl(ctx, request, { signal: current.signal, snapshot, service }), (snapshot?.config?.timeoutSeconds ?? 90) * 1000, current.signal);
            const text = applyResult(raw);
            say(`完成 · ${request.meta.label} · 结果 ${text.length} 字。结果可编辑、复制或填回输入框（不会自动发送）。`);
        } catch (error) {
            if (ticket === revision) { say(invalidateReason || error.message || '转换失败，请重试。'); retryButton.hidden = false; }
        } finally {
            if (controller === current) { controller = null; setBusy(false); }
        }
    }
    function applyResult(raw) {
        const now = getContext() ?? {};
        if (running?.ticket !== revision) throw Error(invalidateReason || '本次转换已过期，结果已丢弃。');
        if (chatIdentity(now) !== running.identity) throw Error('聊天已切换，本次结果已丢弃。');
        if (sourceArea.value !== running.source) throw Error('原文已被修改，本次结果已丢弃。');
        if (running.mode !== mode) throw Error('文风模式已切换，本次结果已丢弃。');
        if (running.mode === 'chat' && referenceStamp(now) !== running.contentStamp) throw Error('聊天内容已更新，本次结果已丢弃。');
        if (running.mode === 'custom' && presetStamp(store.get(presetSelect.value)) !== running.presetMark) throw Error('预设已修改，本次结果已丢弃。');
        // Normalize even for injected generators: strip think blocks, reject empty output.
        const text = normalizeResult(raw);
        const state = chatState();
        state.source = sourceArea.value;
        state.result = text;
        state.meta = running.request.meta;
        setResultState(state);
        invalidateReason = '';
        return text;
    }
    function setResultState(state) {
        resultArea.value = state?.result ?? '';
        resultMeta.textContent = state?.meta ? `本次转换：${state.meta.label} · 原文 ${state.meta.sourceChars} 字。` : '';
        resultCard.hidden = !state?.result;
        fillBase = running?.input ? { node: running.input.node, identity: running.identity, value: running.input.value } : null;
        undoFillState = null;
        undoFillButton.hidden = true;
    }
    function fillBack() {
        if(disposed)return;
        if (busy) { say('正在转换中：请等本次结果完成后再填回。'); return; }
        const text = resultArea.value;
        if (!text.trim()) { say('没有可填回的结果。'); return; }
        let input;
        try { input = inputElement(doc); } catch (error) { say(error.message); return; }
        if (!fillBase || !fillBase.node) { say('无法确认聊天输入框的原始内容（转换时输入框不可用）。已阻止填回以免覆盖草稿；可复制结果后手动粘贴。'); return; }
        const guard = fillGuard({ node: input, expectedNode: fillBase.node, value: input.value, expectedValue: fillBase.value, identity: chatIdentity(getContext() ?? {}), expectedIdentity: fillBase.identity });
        if (!guard.ok) {
            resultArea.focus?.();
            resultArea.select?.();
            say(`${guard.message}已阻止填回；可点“复制结果”后手动粘贴。`);
            return;
        }
        const previous = input.value;
        writeToInput(input, text);
        fillBase = { node: input, identity: fillBase.identity, value: text };
        undoFillState = { node: input, identity: fillBase.identity, base: previous, written: text };
        undoFillButton.hidden = false;
        say('已填回聊天输入框：仅写入草稿并触发 input 事件，不会发送。');
    }
    function undoFill() {
        if(disposed)return;
        if (busy) { say('正在转换中：请等本次结果完成后再撤销填回。'); return; }
        const record = undoFillState;
        if (!record) { say('没有可撤销的填回。'); return; }
        let input;
        try { input = inputElement(doc); } catch (error) { say(error.message); return; }
        const guard = fillGuard({ node: input, expectedNode: record.node, value: input.value, expectedValue: record.written, identity: chatIdentity(getContext() ?? {}), expectedIdentity: record.identity });
        if (!guard.ok) { say(`${guard.message}已阻止自动撤销；可手动编辑输入框。`); return; }
        writeToInput(input, record.base);
        fillBase = { node: input, identity: record.identity, value: record.base };
        undoFillState = null;
        undoFillButton.hidden = true;
        say('已还原填回前的输入框草稿。');
    }

    function renderIdentityNote(ctx) {
        if (!ctx) { identityNote.textContent = '未检测到聊天：可使用自定义文风转换原文；参考聊天模式与“填回聊天输入框”需要打开聊天。'; return; }
        const chatName = ctx.groupId != null ? '群聊' : (ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '角色');
        const chatId = ctx.getCurrentChatId?.() ?? ctx.chatId ?? '';
        identityNote.textContent = `当前聊天：${chatName}${chatId ? ` · ${String(chatId).replace(/\.jsonl?$/i, '')}` : ''} · 原文与结果仅保存在本聊天，不跨聊天显示。`;
    }
    function syncChat(initial = false) {
        const ctx = getContext();
        const next = chatIdentity(ctx ?? {});
        if (!initial && next === identity) { renderIdentityNote(ctx); return; }
        identity = next;
        const hadPending = Boolean(controller);
        reset('聊天已切换，本次转换已取消。');
        const saved = perChat.get(identity) ?? { source: '', result: '', meta: null };
        sourceArea.value = saved.source;
        running = null;
        fillBase = null;
        undoFillState = null;
        setResultState(saved);
        renderIdentityNote(ctx);
        if (!initial) say(hadPending ? '聊天已切换，本次转换已取消；原文草稿与结果按聊天分开保存，互不可见。' : '已切换聊天：原文草稿与结果按聊天分开保存，互不可见。');
    }

    const removers = [];
    const host = settingsContext();
    const events = host?.eventTypes ?? host?.event_types ?? {};
    if (events.CHAT_CHANGED && host?.eventSource?.on) {
        const handler = () => {try{syncChat();}catch(error){reset(error.message);sourceArea.value='';running=null;setResultState(null);say(error.message);}};
        host.eventSource.on(events.CHAT_CHANGED, handler);
        removers.push(() => { const source = host.eventSource; if (source?.removeListener) source.removeListener(events.CHAT_CHANGED, handler); else source?.off?.(events.CHAT_CHANGED, handler); });
    }

    renderModes();
    renderPresetOptions();
    renderPresetEditor();
    syncChat(true);

    const controller_ = {
        open() { syncChat(); },
        acceptSource(text, expectedIdentity) {
            syncChat();
            if(expectedIdentity && expectedIdentity!==identity)throw Error('聊天已变化，不能转交旧候选。');
            if(sourceArea.value.trim() && sourceArea.value!==text)throw Error('改写页已有原文草稿；请先保留或清空，再转交候选。');
            reset('已转入候选，请主动点击转换。');
            sourceArea.value=String(text);touchDraft();running=null;const state=chatState();state.result='';state.meta=null;setResultState(state);say('候选已转入原文，尚未请求 AI，也未发送。');
        },
        convert, fillBack, setMode,
        dispose() {
            if(disposed)return;disposed=true;
            revision++;
            controller?.abort(new Error('面板已关闭，转换取消。'));
            for (const remove of removers) remove();
            unsubscribe?.();
            contentControls.dispose();
            store?.clearDrafts(draftOwner);
            clearTimeout(armTimer);
            root.remove();
            mounted.delete(target);
        },
    };
    mounted.set(target, controller_);
    return controller_;
}
