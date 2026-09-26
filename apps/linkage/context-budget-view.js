import { MODULES } from './policy.js';

/** Uses the parent settings draft and save button, so budget edits save atomically. */
export function renderContextBudgetControls(target, { document = target.ownerDocument, settings, onChange }) {
    const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    const panel = make('details'); panel.className = 'amin-stack';
    panel.append(make('summary', 'AI 资料预算与固定保留'));
    panel.append(make('p', '预算仅限制 Amin 插入的剧情资料字符数，不是 token 数，也不包含世界书更新规则。按完整模块取舍；可更新模块、已启用剧情引用和生效能力必须保留。必需资料超限会明确报错。'));
    let value = structuredClone(settings.contextBudget ?? { enabled: false, maxChars: 24000, requiredModules: [] });
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
    target.append(panel);
    return { element: panel, inputs };
}

export function renderContextBudgetReport(target, report, { document = target.ownerDocument } = {}) {
    const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    const panel = make('details'); panel.className = 'amin-stack'; panel.append(make('summary', '资料纳入预览（已保存设置）'));
    panel.append(make('p', report.error || `资料提示词 ${report.usedChars} 字符${report.enabled ? ` / 预算 ${report.maxChars} 字符` : ' · 预算未启用'}。模块大小不含路径索引等公共开销。`));
    const list = make('ul');
    for (const row of report.modules) list.append(make('li', `${row.label}：${row.included ? '已纳入' : '未纳入'}${row.required ? ' · 必需' : ''} · ${row.chars} 字符 · ${row.reason}`));
    panel.append(list); target.append(panel); return panel;
}
