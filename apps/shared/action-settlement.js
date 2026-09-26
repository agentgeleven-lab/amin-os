import { adapter as status } from '../linkage/adapters/status.js';
import { adapter as inventory } from '../linkage/adapters/inventory.js';
import { readCharacters } from '../characters/model.js';
import { readInventory } from '../inventory/model.js';
import { operationReference } from '../effects/settlement.js';
import { adapter as scene } from '../linkage/adapters/scene.js';
import { readHistory } from '../dice/service.js';

export function actionResources(ctx) {
    const stats = readCharacters(ctx).characters.flatMap(character => character.stats.map(stat => {
        const operation = { kind: 'stat', characterId: character.id, statId: stat.id };
        try { const ref = operationReference(ctx, operation); return { ...operation, label: ref.label, value: ref.value }; } catch { return null; }
    }).filter(Boolean));
    const items = readInventory(ctx).items.map(item => ({ kind: 'item', itemId: item.id, label: `${item.name}（${item.ownerId}）`, value: item.quantity }));
    return { stats, costs: [...stats, ...items], rolls: readHistory(ctx).slice().reverse().slice(0, 50).map(roll => ({ id: roll.id, text: roll.text })) };
}

// Preview operates on a clone. The shared operation service alone applies and saves.
export function buildActionSettlement(ctx, input, { operationId, now = new Date().toISOString() } = {}) {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 120) throw Error('请填写 120 字以内的行动名称。');
    const minutes = input.minutes ?? 0;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 5256000) throw Error('耗时应为 0–5256000 的整数分钟。');
    if (!input.cost && !input.target && !minutes) throw Error('至少设置一项消耗、目标变化或耗时。');
    const roll = input.rollId ? readHistory(ctx).find(roll => roll.id === input.rollId) : null;
    if (input.rollId && !roll) throw Error('所选骰点已不存在，请重新选择。');
    const working = { ...ctx, chatMetadata: structuredClone(ctx.chatMetadata) }, patches = new Map(), rows = [];
    const apply = (operation, amount, cost) => {
        if (!Number.isFinite(amount) || Math.abs(amount) > 1e9 || (cost ? amount <= 0 : amount === 0)) throw Error('消耗必须大于零，目标变化必须为非零有限数字。');
        if (!['stat', 'item'].includes(operation.kind) || (!cost && operation.kind !== 'stat')) throw Error('行动资源类型无效。');
        const before = operationReference(working, operation);
        if (cost && before.value < amount) throw Error(`${before.label}：资源不足。`);
        const result = operation.kind === 'stat'
            ? status.apply(working, { module: 'status', action: 'adjust', target: before.binding, data: { delta: cost ? -amount : amount, component: before.component }, reason: `行动结算：${name}` }, { now })
            : inventory.apply(working, { module: 'inventory', action: 'consume-item', target: operation.itemId, data: { quantity: amount }, reason: `行动结算：${name}` }, { operationId, now });
        for (const patch of result.patches) {
            let parent = working.chatMetadata;
            for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
            if (patch.remove) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = structuredClone(patch.value);
            patches.set(JSON.stringify(patch.path), patch);
        }
        rows.push(`${before.label}：${before.value} → ${operationReference(working, operation).value}`);
    };
    if (input.cost) apply(input.cost, input.costAmount, true);
    if (input.target) apply(input.target, input.delta, false);
    if (minutes) {
        const result = scene.apply(working, { module: 'scene', action: 'advance-time', data: { minutes }, reason: `行动结算：${name}` }, { operationId, now });
        for (const patch of result.patches) patches.set(JSON.stringify(patch.path), patch);
        rows.push(`剧情时间推进 ${minutes} 分钟（到期周期效果仍需另行预览结算）`);
    }
    if (roll) rows.push(`引用已有骰点（不重新掷骰，不自动换算增减值）：${roll.text}`);
    return { patches: [...patches.values()], rows, name, text: `【已结算行动：${name}】\n${rows.join('\n')}\n以上为已确认的固定结果，请据此描写，不要重复扣除或结算。` };
}
