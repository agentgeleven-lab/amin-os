import { readCharacters } from '../characters/model.js';
import { readInventory } from '../inventory/model.js';
import { validatePeriodicConfig, validateStacking } from './rules.js';

const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
const field = (parent, label, value = '') => { const wrapper = node('label', label, 'amin-field'), input = node('input'); input.value = String(value); input.setAttribute('aria-label', label); wrapper.append(input); parent.append(wrapper); return input; };
const select = (parent, label, options, value) => {
    const wrapper = node('label', label, 'amin-field'), input = node('select'); input.setAttribute('aria-label', label);
    for (const [key, label] of options) { const option = node('option', label); option.value = key; input.append(option); }
    input.value = value; wrapper.append(input); parent.append(wrapper); return input;
};
const numeric = (input, label) => { if (!input.value.trim()) throw Error(`请填写${label}。`); return Number(input.value); };

export function ruleFields(parent, { effect, ctx, onChange = () => {} } = {}) {
    const details = node('details', null, 'amin-stack'); details.append(node('summary', '叠加与周期规则（可选）')); parent.append(details);
    const grid = node('div', null, 'amin-form-grid'); details.append(grid);
    const stackingMode = select(grid, '状态叠加方式', [['legacy', '沿用原规则：同一层面不重复'], ['independent', '独立：每次建立单独效果'], ['refresh', '刷新：同类效果重新计时'], ['stack', '叠层：同类效果增加层数并重新计时']], effect?.stacking?.mode ?? 'legacy');
    const key = field(grid, '状态类型编号', effect?.stacking?.key ?? 'status'); key.placeholder = '例如 poison；用于识别同类效果';
    const maximum = field(grid, '最大层数', effect?.stacking?.maxStacks ?? 1); maximum.type = 'number'; maximum.min = 1; maximum.max = 100;
    const stacks = field(grid, effect ? '当前层数' : '本次层数', effect?.stacking?.stacks ?? 1); stacks.type = 'number'; stacks.min = 1; stacks.max = 100;
    let stackingChanged = false;
    const reflectStacking = () => { key.parentElement.hidden = stackingMode.value === 'legacy'; maximum.parentElement.hidden = stacks.parentElement.hidden = stackingMode.value !== 'stack'; };
    for (const input of [stackingMode, key, maximum, stacks]) input.onchange = () => { stackingChanged = true; reflectStacking(); onChange(); };
    for (const input of [key, maximum, stacks]) input.oninput = input.onchange;
    reflectStacking();
    const periodicMode = select(details, '周期结算规则', [...(effect ? [['keep', '保留现有规则与结算记录']] : []), ['none', '不使用周期结算'], ['set', '设置或重设周期规则']], effect ? 'keep' : 'none');
    const configuration = node('section', null, 'amin-card amin-stack'); details.append(configuration);
    const interval = field(configuration, '每隔多少游戏分钟结算', effect?.periodic?.intervalMinutes ?? 10); interval.type = 'number'; interval.min = 1; interval.max = 5256000;
    const scale = select(configuration, '层数对周期数值的影响', [['false', '每个周期只计算一份'], ['true', '每个周期乘以当前层数']], String(effect?.periodic?.scaleWithStacks ?? false));
    configuration.append(node('p', '数值使用人物卡的世界状态绑定；物品和资源使用背包原条目。时间推进后需预览并确认结算。刷新、叠层或重设周期前须先处理待结算周期；重新计时从确认时刻开始。', 'amin-meta'));
    const operations = node('div', null, 'amin-stack'); configuration.append(operations);
    const characters = readCharacters(ctx).characters, inventory = readInventory(ctx), rows = [];
    const ownerLabel = ownerId => characters.find(character => character.id === ownerId)?.name ?? `已失效持有人 ${ownerId}`;
    function appendOperation(value = { kind: 'stat' }) {
        if (rows.length >= 12) return;
        const card = node('section', null, 'amin-card amin-form-grid'); operations.append(card);
        const kind = select(card, '周期操作类型', [['stat', '人物绑定数值增减'], ['item', '背包物品消耗'], ['balance', '资源账户增减']], value.kind);
        const reference = select(card, '周期操作对象', [['', '请选择']], ''), amount = field(card, '每周期增减量（负数为消耗）', value.quantity ?? value.delta ?? -1); amount.type = 'number'; amount.step = 'any';
        function populate(source) {
            const choices = [['', '请选择']];
            if (kind.value === 'stat') for (const character of characters) for (const stat of character.stats) choices.push([JSON.stringify([character.id, stat.id]), `${character.name} · ${stat.label} (${stat.binding})`]);
            if (kind.value === 'item') for (const item of inventory.items) choices.push([item.id, `${ownerLabel(item.ownerId)} · ${item.name} · ${item.quantity} 件`]);
            if (kind.value === 'balance') for (const balance of inventory.balances) choices.push([balance.id, `${ownerLabel(balance.ownerId)} · ${balance.name} · ${balance.amount}${balance.unit}`]);
            const selected = source?.kind === 'stat' && source.characterId ? JSON.stringify([source.characterId, source.statId]) : source?.itemId ?? source?.balanceId ?? '';
            if (selected && !choices.some(([id]) => id === selected)) choices.push([selected, `绑定已失效：${selected}`]);
            reference.replaceChildren(); for (const [id, label] of choices) { const option = node('option', label); option.value = id; reference.append(option); } reference.value = selected;
            amount.setAttribute('aria-label', kind.value === 'item' ? '每周期消耗件数' : '每周期增减量（负数为消耗）');
            amount.step = kind.value === 'item' ? '1' : 'any';
        }
        populate(value);
        kind.onchange = () => { populate(); amount.value = kind.value === 'item' ? '1' : '-1'; onChange(); };
        const remove = node('button', '移除此周期操作'); remove.type = 'button'; card.append(remove);
        const row = { read() { const number = numeric(amount, '周期增减量'); if (kind.value === 'stat') { if (!reference.value) throw Error('请选择人物绑定属性。'); const [characterId, statId] = JSON.parse(reference.value); return { kind: 'stat', characterId, statId, delta: number }; } return kind.value === 'item' ? { kind: 'item', itemId: reference.value, quantity: number } : { kind: 'balance', balanceId: reference.value, delta: number }; } };
        rows.push(row); remove.onclick = () => { rows.splice(rows.indexOf(row), 1); card.remove(); onChange(); };
        reference.onchange = amount.onchange = onChange;
    }
    for (const operation of effect?.periodic?.operations ?? [{ kind: 'stat' }]) appendOperation(operation);
    const add = node('button', '添加周期操作'); add.type = 'button'; add.onclick = () => { appendOperation(); onChange(); }; configuration.append(add);
    const reflectPeriodic = () => { configuration.hidden = periodicMode.value !== 'set'; onChange(); }; periodicMode.onchange = reflectPeriodic; reflectPeriodic();
    return { element: details, read() {
        const result = {};
        if (!effect || stackingChanged) {
            if (stackingMode.value === 'legacy') { if (effect?.stacking) result.stacking = null; }
            else result.stacking = validateStacking({ mode: stackingMode.value, key: key.value.trim(), maxStacks: stackingMode.value === 'stack' ? numeric(maximum, '最大层数') : 1, stacks: stackingMode.value === 'stack' ? numeric(stacks, '层数') : 1 });
        }
        if (periodicMode.value === 'set') result.periodic = validatePeriodicConfig({ intervalMinutes: numeric(interval, '结算间隔'), scaleWithStacks: scale.value === 'true', operations: rows.map(row => row.read()) });
        else if (periodicMode.value === 'none' && effect?.periodic) result.periodic = null;
        return result;
    } };
}

export function appendRules(parent, effect) {
    if (effect.stacking) parent.append(node('p', `叠加规则：${{ independent: '独立效果', refresh: '同类刷新', stack: '同类叠层' }[effect.stacking.mode]} · ${effect.stacking.key}${effect.stacking.mode === 'stack' ? ` · ${effect.stacking.stacks}/${effect.stacking.maxStacks} 层` : ''}`, 'amin-meta'));
    if (effect.periodic) parent.append(node('p', effect.periodicStatus?.label ?? `周期结算：每 ${effect.periodic.intervalMinutes} 游戏分钟`, 'amin-meta'));
}
