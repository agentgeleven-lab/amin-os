import { MODULES } from './policy.js';

/** Uses the parent settings draft and save button, so edits save atomically. */
export function renderContextBudgetControls(target, { document = target.ownerDocument, settings, onChange, report = null, onRefresh }) {
    const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    const panel = make('details'); panel.className = 'amin-stack'; panel.setAttribute('style', 'min-width:0;overflow-wrap:anywhere');
    panel.append(make('summary', 'AI 资料预算与固定保留'));
    panel.append(make('p', '预算仅限制 Amin 插入的剧情资料字符数，不是 token 数，也不包含世界书更新规则。可更新模块、已启用剧情引用和生效能力必须保留。必需资料超限会明确报错。'));
    let value = { enabled: false, maxChars: 24000, requiredModules: [], ...structuredClone(settings.contextBudget ?? {}) };
    value.entrySelection = { enabled: false, pinned: [], ...value.entrySelection };
    const inputs = [];
    const change = patch => { value = { ...value, ...patch }; onChange(structuredClone(value)); };
    const checkbox = (text, checked, handler) => {
        const row = make('label'), input = make('input'); row.className = 'amin-check'; input.type = 'checkbox'; input.checked = checked;
        input.setAttribute('aria-label', text); input.addEventListener('change', () => { if (!input.disabled) handler(input.checked); });
        row.append(input, make('span', text)); inputs.push(input); panel.append(row);
    };
    checkbox('启用剧情资料预算', value.enabled, enabled => change({ enabled }));
    const limitRow = make('label', '资料上限（字符）'), limit = make('input'); limit.type = 'number'; limit.min = '1000'; limit.max = '2000000'; limit.step = '1000'; limit.value = String(value.maxChars);
    limit.setAttribute('aria-label', '剧情资料字符上限'); limit.addEventListener('input', () => { if (!limit.disabled) change({ maxChars: Number(limit.value) }); });
    inputs.push(limit); limitRow.append(limit); panel.append(limitRow);
    panel.append(make('p', '以下固定项只在该模块已启用且允许读取时生效，不会绕过资料权限。'));
    for (const [id, [label]] of Object.entries(MODULES)) checkbox(`固定保留：${label}`, value.requiredModules.includes(id), checked => change({ requiredModules: checked ? [...new Set([...value.requiredModules, id])] : value.requiredModules.filter(item => item !== id) }));
    checkbox('启用条目级资料筛选', value.entrySelection.enabled, enabled => change({ entrySelection: { ...value.entrySelection, enabled } }));
    panel.append(make('p', '按当前场景及明确关联选择人物、关系、物品与档案。允许更新的模块仍完整保留：如果所有模块都开启写权限，筛选不会缩减这些模块。固定条目在筛选开启时保留。下方候选来自已保存权限下可见的资料，修改权限后请先保存。'));
    const entries = Array.isArray(report?.entrySelection?.entries) ? report.entrySelection.entries : [];
    const catalog = new Map(entries.map(entry => [entry.id, entry]));
    const search = make('input'); search.type = 'search'; search.placeholder = '搜索人物、物品或档案'; search.setAttribute('aria-label', '搜索固定资料条目');
    const select = make('select'); select.setAttribute('aria-label', '固定资料条目'); select.setAttribute('style', 'width:100%;min-width:0;max-width:100%');
    const count = make('small'), pinned = make('p'); pinned.setAttribute('aria-live', 'polite');
    const labelOf = entry => `${MODULES[entry.module]?.[0] ?? entry.module} · ${entry.label || entry.id}`;
    const render = () => {
        const prior = select.value, query = search.value.trim().toLocaleLowerCase(); select.textContent = '';
        const choices = [...catalog.values(), ...value.entrySelection.pinned.filter(id => !catalog.has(id)).map(id => ({ id, module: '', label: `当前不可见／已不存在：${id}` }))];
        const filtered = choices.filter(entry => `${labelOf(entry)} ${entry.id}`.toLocaleLowerCase().includes(query));
        const placeholder = make('option', '选择要固定或取消固定的条目'); placeholder.value = ''; select.append(placeholder);
        for (const entry of filtered.slice(0, 200)) { const option = make('option', `${value.entrySelection.pinned.includes(entry.id) ? '已固定 · ' : ''}${labelOf(entry)}`); option.value = entry.id; select.append(option); }
        select.value = filtered.slice(0, 200).some(entry => entry.id === prior) ? prior : '';
        count.textContent = filtered.length > 200 ? `匹配 ${filtered.length} 项，仅列出前 200 项，请缩小搜索范围。` : `可选 ${filtered.length} 项。`;
        pinned.textContent = value.entrySelection.pinned.length ? `已固定 ${value.entrySelection.pinned.length} 项：${value.entrySelection.pinned.map(id => catalog.has(id) ? labelOf(catalog.get(id)) : `${id}（当前不可见／已不存在）`).join('；')}` : '尚未固定单独条目。';
    };
    search.addEventListener('input', () => { if (!search.disabled) render(); });
    const pin = make('button', '固定选中条目'), unpin = make('button', '取消固定选中条目'); pin.type = unpin.type = 'button';
    const setPin = enabled => {
        if (!select.value) return;
        const next = enabled ? [...new Set([...value.entrySelection.pinned, select.value])] : value.entrySelection.pinned.filter(id => id !== select.value);
        change({ entrySelection: { ...value.entrySelection, pinned: next } }); render();
    };
    pin.addEventListener('click', () => { if (!pin.disabled && catalog.has(select.value)) setPin(true); });
    unpin.addEventListener('click', () => { if (!unpin.disabled) setPin(false); });
    const actions = make('div'); actions.className = 'amin-actions'; actions.append(pin, unpin);
    if (typeof onRefresh === 'function') { const refresh = make('button', '刷新可选条目'); refresh.type = 'button'; refresh.addEventListener('click', () => { if (!refresh.disabled) onRefresh(); }); inputs.push(refresh); actions.append(refresh); }
    inputs.push(search, select, pin, unpin); panel.append(search, select, count, actions, pinned); render();
    target.append(panel);
    return { element: panel, inputs };
}

export function renderContextBudgetReport(target, report, { document = target.ownerDocument } = {}) {
    const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    const panel = make('details'); panel.className = 'amin-stack'; panel.setAttribute('style', 'min-width:0;overflow-wrap:anywhere'); panel.append(make('summary', '资料纳入预览（已保存设置）'));
    panel.append(make('p', report.error || `资料提示词 ${report.usedChars} 字符${report.enabled ? ` / 预算 ${report.maxChars} 字符` : ' · 预算未启用'}。模块大小不含路径索引等公共开销。`));
    const list = make('ul');
    for (const row of report.modules ?? []) list.append(make('li', `${row.label}：${row.included ? '已纳入' : '未纳入'}${row.required ? ' · 必需' : ''} · ${row.chars} 字符 · ${row.reason}`));
    panel.append(list);
    const selection = report.entrySelection;
    if (selection) {
        panel.append(make('p', `条目筛选${selection.enabled ? '已启用' : '未启用'}。以下为当前资料预览，不代表上一轮实际请求。`));
        const entries = selection.entries ?? [], search = make('input'); search.type = 'search'; search.setAttribute('aria-label', '搜索资料纳入预览'); search.placeholder = '搜索条目或纳入原因';
        const rows = make('div'), count = make('small'), previous = make('button', '上一页'), next = make('button', '下一页'); previous.type = next.type = 'button';
        let page = 0;
        const render = () => {
            const query = search.value.trim().toLocaleLowerCase(), filtered = entries.filter(row => `${row.label} ${row.id} ${row.reason}`.toLocaleLowerCase().includes(query));
            const pages = Math.max(1, Math.ceil(filtered.length / 30)); page = Math.min(page, pages - 1); rows.textContent = '';
            for (const row of filtered.slice(page * 30, (page + 1) * 30)) {
                const item = make('p'); item.className = 'amin-notice'; item.append(make('strong', `${MODULES[row.module]?.[0] ?? row.module} · ${row.label || row.id}`), make('br'), make('span', `${row.included ? '已纳入' : '未纳入'}${row.required ? ' · 必需' : ''} · ${row.reason}`)); rows.append(item);
            }
            count.textContent = `${filtered.length} 项 · 第 ${page + 1} / ${pages} 页`; previous.disabled = page === 0; next.disabled = page >= pages - 1;
        };
        search.addEventListener('input', () => { page = 0; render(); }); previous.addEventListener('click', () => { if (!previous.disabled) { page--; render(); } }); next.addEventListener('click', () => { if (!next.disabled) { page++; render(); } });
        const actions = make('div'); actions.className = 'amin-actions'; actions.append(previous, next); panel.append(search, count, rows, actions); render();
    }
    target.append(panel); return panel;
}
