import { KEY, readStore, currentEntries, changeWithContext, sourceFromRange } from '../journal/model.js';
import { adapter as status } from '../linkage/adapters/status.js';
import { adapter as inventory } from '../linkage/adapters/inventory.js';
import { operationReference } from '../effects/settlement.js';

export const settlementTasks = ctx => currentEntries(readStore(ctx), ctx.chat ?? []).filter(record => record.kind === 'task');

// The caller owns a preview clone and applies every patch to it before the next step.
export function buildTaskSettlement(ctx, input, { operationId, now, accept }) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 200) throw Error('任务结算缺少有效操作编号。');
    const task = settlementTasks(ctx).find(record => record.id === input.taskId);
    if (!task) throw Error('所选任务已不在当前分支。');
    if (!['active', 'completed'].includes(input.status) || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100) throw Error('请设置有效的任务状态和 0–100 进度。');
    if (input.status === 'completed' && input.progress !== 100) throw Error('完成任务时进度需为 100。');
    const rewards = input.rewards ?? [], rows = [];
    if (!Array.isArray(rewards) || rewards.length > 32) throw Error('每次任务奖励最多 32 项。');
    if (!input.claimRewards && rewards.length) throw Error('请明确确认领取结构化奖励。');
    if (input.claimRewards) {
        if (input.status !== 'completed') throw Error('完成任务后才能领取奖励。');
        if (task.rewardClaim) throw Error('当前剧情状态已领取此任务奖励，不能重复领取。');
        if (!rewards.length) throw Error('请配置奖励项目；奖励说明文字不会自动发放。');
        for (const [index, reward] of rewards.entries()) {
            if (!['stat', 'item', 'balance'].includes(reward.kind) || !Number.isFinite(reward.amount) || reward.amount <= 0 || reward.amount > 1e9
                || (reward.kind === 'item' && !Number.isInteger(reward.amount))) throw Error('任务奖励需为正数，物品数量需为整数。');
            const before = operationReference(ctx, reward), reason = `任务奖励：${task.title}`;
            const update = reward.kind === 'stat'
                ? status.apply(ctx, { module: 'status', action: 'adjust', target: before.binding, data: { delta: reward.amount, component: before.component }, reason }, { now })
                : inventory.apply(ctx, { module: 'inventory', action: reward.kind === 'item' ? 'save-item' : 'adjust-balance', target: reward.kind === 'item' ? reward.itemId : reward.balanceId,
                    data: reward.kind === 'item' ? { quantity: before.value + reward.amount } : { delta: reward.amount }, reason }, { operationId: `${operationId}:reward:${index}`, now });
            accept(update.patches);
            rows.push(`任务奖励 · ${before.label}：${before.value} → ${operationReference(ctx, reward).value}`);
        }
    }
    const record = { ...task, status: input.status, progress: input.progress,
        sources: sourceFromRange(ctx.chat, ctx.chat.length - 1, ctx.chat.length - 1),
        ...(input.claimRewards ? { rewardClaim: { operationId, at: now } } : {}) };
    accept([{ path: [KEY], value: changeWithContext(readStore(ctx), ctx, 'update', record, `${operationId}:task`, now) }]);
    rows.unshift(`任务「${task.title}」：${task.progress}% → ${input.progress}% · ${input.status === 'completed' ? '已完成' : '进行中'}`);
    if (!input.claimRewards) rows.push('本次未发放任务奖励。');
    return rows;
}
