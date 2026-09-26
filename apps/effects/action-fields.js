// These presets only fill the current draft. Resource IDs and rewards are always selected explicitly.
export const ACTION_TEMPLATES = [
    { id: 'healing', name: '治疗', minutes: 0, hint: '请选择治疗目标的已绑定属性和恢复数值；如消耗药品或魔力，请明确选择资源。' },
    { id: 'rest', name: '休息', minutes: 60, hint: '默认休息 60 分钟，可自行修改；属性恢复量需要明确填写。' },
    { id: 'travel', name: '旅行', minutes: 60, hint: '默认行进 60 分钟，可自行修改；不会自动移动场景或推断路线。' },
];

export function actionTaskFields(parent, resources, { node, field, select, button, grid, toolbar }) {
    const section = node('details');
    section.append(node('summary', '关联任务与奖励（可选）'));
    parent.append(section);
    section.append(node('p', '任务进度与本次行动一起预览和保存。奖励说明仅供参考；只有勾选发放并逐项配置的奖励才会执行。', 'amin-meta'));
    const fields = grid(section);
    const task = select(fields, '关联任务', [['', '不关联任务'], ...(resources.tasks ?? []).map(t => [t.id, `${t.title} · ${t.progress}%${t.rewardClaimed ? ' · 奖励已领取' : ''}`])]);
    const status = select(fields, '任务结算状态', [['active', '进行中'], ['completed', '完成']]);
    const progress = field(fields, '任务进度（0–100）', '0');
    progress.type = 'number'; progress.min = '0'; progress.max = '100'; progress.step = '1';
    const description = node('p', '', 'amin-meta'); section.append(description);
    const checkLabel = node('label', '', 'amin-check'), claim = node('input');
    claim.type = 'checkbox'; claim.setAttribute('aria-label', '确认发放本次配置的任务奖励');
    checkLabel.append(claim, node('span', '确认发放本次配置的任务奖励')); section.append(checkLabel);
    const list = node('div', '', 'amin-stack'); section.append(list);
    const rows = []; let serial = 0;
    const refresh = () => {
        const selected = (resources.tasks ?? []).find(t => t.id === task.value);
        status.disabled = progress.disabled = !selected;
        claim.disabled = !selected || selected.rewardClaimed || status.value !== 'completed';
        if (claim.disabled) claim.checked = false;
        description.textContent = selected ? `奖励说明：${selected.reward || '未填写'}${selected.rewardClaimed ? '（此历史中已领取，不能重复发放）' : ''}` : '请先选择任务。';
        list.hidden = add.parentElement.hidden = !claim.checked;
    };
    const add = button(toolbar(section), '添加奖励项', () => {
        if (rows.length >= 16) throw Error('一次最多配置 16 项奖励。');
        const row = node('section', '', 'amin-card amin-stack'), inputs = grid(row), index = ++serial;
        const resource = select(inputs, `奖励 ${index} 的资源`, [['', '请选择已有属性、物品或账户'], ...(resources.rewards ?? []).map((r, i) => [String(i), `${r.label} · ${r.value}`])]);
        const amount = field(inputs, `奖励 ${index} 的数量`, '1'); amount.type = 'number'; amount.min = '0'; amount.step = 'any';
        const entry = { row, resource, amount }; rows.push(entry); list.append(row);
        button(toolbar(row), `移除奖励 ${index}`, () => { rows.splice(rows.indexOf(entry), 1); row.remove(); });
    });
    task.onchange = () => { const selected = (resources.tasks ?? []).find(t => t.id === task.value); progress.value = String(selected?.progress ?? 0); status.value = selected?.status === 'completed' ? 'completed' : 'active'; claim.checked = false; refresh(); };
    status.onchange = () => { if (status.value === 'completed') progress.value = '100'; refresh(); };
    claim.onchange = refresh; refresh();
    return { read() {
        if (!task.value) return undefined;
        const rewards = claim.checked ? rows.map(({ resource, amount }) => {
            const ref = resources.rewards?.[Number(resource.value)];
            if (resource.value === '' || !ref) throw Error('请选择每项奖励的已有资源。');
            return { ...ref, amount: Number(amount.value) };
        }) : [];
        if (claim.checked && !rewards.length) throw Error('请配置至少一项奖励，或取消发放奖励。');
        return { taskId: task.value, status: status.value, progress: Number(progress.value), claimRewards: !!claim.checked, rewards };
    } };
}
