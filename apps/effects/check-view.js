import { createAbilityCheckService } from './checks.js';

// A separate session per mounted form prevents another floor/window from
// replacing this form's pending ability check. Both sessions reuse fixed dice.
export function mountCheckView(target, { getSelection, service, getContext, effects, dice, onApplied } = {}) {
    if (typeof getSelection !== 'function') throw Error('能力检定需要当前发动资料。');
    const dependencies = { ...(effects ? { effects } : {}), ...(dice ? { dice } : {}) };
    const owned = !service, api = service ?? createAbilityCheckService(getContext, dependencies), doc = target.ownerDocument ?? document;
    let disposed = false, selectedStamp = '', characters = [], selectionError = '';
    try { selectedStamp = JSON.stringify(getSelection()); } catch (e) { selectionError = e.message; }
    const node = (tag, text, cls) => { const element = doc.createElement(tag); if (text != null) element.textContent = text; if (cls) element.className = cls; return element; };
    const root = node('details', null, 'amin-card amin-stack amin-ability-check');
    root.append(node('summary', '先做人物属性检定（可选）'));
    const panel = node('div', null, 'amin-stack'); root.append(panel); target.append(root);
    panel.append(node('p', '读取人物绑定的世界状态数值，本地掷骰后保留固定结果；发动效果需要另行确认。', 'amin-help'));
    const fields = node('div', null, 'amin-form-grid'); panel.append(fields);
    const control = (label, choices, value = '', type = 'text') => {
        const wrapper = node('label', label, 'amin-field'), input = node(choices ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (choices) for (const [id, title] of choices) { const option = node('option', title); option.value = id; input.append(option); }
        else input.type = type;
        input.value = String(value); wrapper.append(input); fields.append(wrapper); return input;
    };
    const actor = control('检定人物', [['', '请选择人物']]);
    const stat = control('绑定属性 / 技能', [['', '请选择属性']]);
    const mode = control('检定规则', [['d20', 'D20'], ['coc', 'CoC 7']], 'd20');
    const valueMode = control('D20 绑定值用途', [['modifier', '作为调整值直接相加'], ['score', '作为属性值，换算 ⌊(值−10)/2⌋']], 'modifier');
    const modifier = control('额外修正', null, 0, 'number'); modifier.step = '1';
    const dc = control('D20 目标 DC / AC（可留空）', null, '', 'number'); dc.step = '1';
    const advantage = control('D20 优劣势', [['normal', '普通'], ['advantage', '优势'], ['disadvantage', '劣势']], 'normal');
    const critical = control('D20 自然骰规则', [['check', '普通检定（1 / 20 不自动成败）'], ['attack', '攻击（自然 1 / 20 自动成败）'], ['house', '自定义（自然 1 / 20 自动成败）']], 'check');
    const difficulty = control('CoC 难度', [['regular', '普通'], ['hard', '困难'], ['extreme', '极难']], 'regular');
    const bonus = control('CoC 奖励骰', [['0', '0'], ['1', '1'], ['2', '2']], 0);
    const penalty = control('CoC 惩罚骰', [['0', '0'], ['1', '1'], ['2', '2']], 0);
    const liveValue = node('p', '', 'amin-meta'); panel.append(liveValue);
    const tools = node('div', null, 'amin-toolbar'); panel.append(tools);
    const result = node('div', null, 'amin-stack'); panel.append(result);
    const notice = node('p', '', 'amin-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); panel.append(notice);
    function say(text, state = 'success') { if (disposed) return; notice.textContent = text; notice.dataset.state = state; }
    function button(parent, title, action, cls = '') {
        const element = node('button', title, cls); element.type = 'button';
        element.onclick = async () => { element.disabled = true; try { await action(); } catch (e) { say(e.message, 'error'); } finally { if (!disposed) { element.disabled = api.busy(); } } };
        parent.append(element); return element;
    }
    function options() { return { characterId: actor.value, statId: stat.value, mode: mode.value, valueMode: valueMode.value, modifier: modifier.value,
        dc: dc.value, advantage: advantage.value, critical: critical.value, difficulty: difficulty.value, bonus: bonus.value, penalty: penalty.value }; }
    function reflectMode() {
        for (const input of [valueMode, dc, advantage, critical]) input.parentElement.hidden = mode.value !== 'd20';
        for (const input of [difficulty, bonus, penalty]) input.parentElement.hidden = mode.value !== 'coc';
    }
    function showValue() {
        try { const resolved = api.resolve(actor.value, stat.value); liveValue.textContent = `当前绑定：${resolved.stat.binding} · ${resolved.label} = ${resolved.value}。效果使用者将记录为“${resolved.character.name}”。`; }
        catch (e) { liveValue.textContent = actor.value && stat.value ? e.message : '请先在人物应用中创建人物，并绑定世界状态的数值字段。'; }
    }
    function chooseStats(preferred = '') {
        stat.replaceChildren();
        const empty = node('option', '请选择属性'); empty.value = ''; stat.append(empty);
        const items = characters.find(character => character.id === actor.value)?.stats ?? [];
        for (const item of items) {
            const option = node('option', `${item.label} · ${item.binding}`); option.value = item.id; stat.append(option);
        }
        stat.value = items.some(item => item.id === preferred) ? preferred : items[0]?.id ?? '';
        const selected = characters.find(character => character.id === actor.value)?.stats.find(item => item.id === stat.value);
        if (selected?.check === 'coc' || selected?.check === 'd20') mode.value = selected.check;
        reflectMode(); showValue();
    }
    function reloadCharacters() {
        const previous = actor.value, previousStat = stat.value;
        characters = api.characters(); actor.replaceChildren();
        const empty = node('option', characters.length ? '请选择人物' : '暂无人物资料'); empty.value = ''; actor.append(empty);
        for (const character of characters) { const option = node('option', `${character.name} · ${character.kind.toUpperCase()}`); option.value = character.id; actor.append(option); }
        actor.value = characters.some(character => character.id === previous) ? previous : '';
        if (!actor.value) {
            let holder = '';
            try { holder = String(getSelection()?.holder ?? '').trim(); } catch { /* Invalid effect fields do not hide the character list. */ }
            const matches = characters.filter(character => character.name === holder);
            if (matches.length === 1) actor.value = matches[0].id;
        }
        chooseStats(previousStat);
    }
    function invalidate() { api.invalidate(); showValue(); }
    actor.onchange = () => { chooseStats(); invalidate(); };
    stat.onchange = () => {
        const selected = characters.find(character => character.id === actor.value)?.stats.find(item => item.id === stat.value);
        if (selected?.check === 'coc' || selected?.check === 'd20') mode.value = selected.check;
        reflectMode(); invalidate();
    };
    mode.onchange = () => { reflectMode(); invalidate(); };
    for (const input of [valueMode, modifier, dc, advantage, critical, difficulty, bonus, penalty]) input.addEventListener('input', invalidate);
    const previewButton = button(tools, '预览检定', () => { const selected = getSelection(); selectedStamp = JSON.stringify(selected); api.stage(selected, options()); root.open = true; }, 'amin-primary');
    const refreshButton = button(tools, '刷新人物与数值', () => { reloadCharacters(); invalidate(); });
    function drawResult() {
        if (disposed) return;
        const pending = api.preview(), processing = api.busy(); root.setAttribute('aria-busy', String(processing));
        previewButton.disabled = processing; refreshButton.disabled = processing; result.replaceChildren();
        previewButton.textContent = pending?.record ? '预览新的检定' : '预览检定';
        say(api.status(), processing ? 'busy' : pending?.stale ? 'error' : 'success');
        if (!pending) return;
        const card = node('section', null, 'amin-result amin-stack');
        card.append(node('h4', `${pending.character.name} · ${pending.skill.name}`, 'amin-section-heading'));
        card.append(node('p', `${pending.stat.label}：${pending.value}（${pending.stat.binding}）`, 'amin-meta'));
        const config = pending.config;
        card.append(node('p', config.mode === 'dnd'
            ? `D20 ${pending.options.valueMode === 'score' ? '属性换算后' : '绑定调整值'} + 额外修正 = ${config.modifier}；${{ normal: '普通', advantage: '优势', disadvantage: '劣势' }[config.advantage]}；${config.dc == null ? '未指定目标，仅记录总值' : '目标 ' + config.dc}`
            : `CoC 技能值 + 额外修正 = ${config.skill}；${{ regular: '普通', hard: '困难', extreme: '极难' }[config.difficulty]}；奖励 ${config.bonus} / 惩罚 ${config.penalty}`));
        card.append(node('p', `${pending.selection.targetMode === 'direct' ? '直接发动（无指定对象）' : '目标：' + pending.selection.target} · ${pending.selection.scope}；${pending.selection.durationMinutes == null ? pending.selection.condition : `持续 ${pending.selection.durationMinutes} 游戏分钟；${pending.selection.condition}`}`, 'amin-meta'));
        if (pending.record) card.append(node('pre', pending.record.text));
        if (pending.stale) card.append(node('p', `${pending.error}${pending.record ? ' 固定结果仍保留在骰子历史中。' : ''}`, 'amin-help'));
        const actions = node('div', null, 'amin-toolbar');
        const disable = button => { button.disabled = processing || pending.stale; return button; };
        if (!pending.record) disable(button(actions, '确认本地掷骰', () => api.roll(), 'amin-primary'));
        else {
            if (pending.dirty || pending.effectDirty) disable(button(actions, '重试保存（不重新掷骰）', () => api.retrySave()));
            if (pending.record.status === 'rolled') disable(button(actions, '追加固定结果到草稿', () => api.append(doc.querySelector('#send_textarea')), 'amin-primary'));
            else card.append(node('p', pending.record.status === 'sent' ? '此结果已随消息发送。' : '此结果已追加到聊天草稿。', 'amin-meta'));
            if (pending.applied) card.append(node('p', '这个结果已确认过效果。', 'amin-meta'));
            else {
                const consent = node('label', null, 'amin-check'), check = node('input'); check.type = 'checkbox';
                const outcome = pending.record.results[0]?.success;
                consent.append(check, node('span', `${outcome === false ? '本次未达目标；我仍' : '我'}确认按上面的目标与范围建立持续效果。`)); card.append(consent);
                const apply = button(actions, '确认检定后的效果', async () => { const applied = await api.apply(); if (!disposed) onApplied?.(applied); });
                apply.disabled = true;
                check.onchange = () => { apply.disabled = !check.checked || api.busy() || pending.stale || pending.dirty || pending.effectDirty; };
            }
        }
        card.append(actions); result.append(card);
    }
    const unsubscribe = api.subscribe(drawResult);
    try { reloadCharacters(); } catch (e) { say(e.message, 'error'); }
    reflectMode(); drawResult(); if (selectionError) say(selectionError, 'error');
    return {
        open() { root.open = true; this.refresh(); },
        refresh() {
            if (disposed) return;
            try {
                const next = JSON.stringify(getSelection());
                if (next !== selectedStamp) { selectedStamp = next; api.invalidate('发动资料已变化，请重新预览检定。'); }
                else drawResult();
                showValue();
            } catch (error) { api.invalidate(error.message); say(error.message, 'error'); }
        },
        dispose() { if (disposed) return; disposed = true; unsubscribe(); if (owned) api.dispose(); root.remove(); },
    };
}
