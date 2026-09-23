import { validateClock, calendarKey } from '../scene/model.js';
import { clockMinutes, timingStatus } from './timing.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, label) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error(`${label}无效。`);
    return value;
};
const inventoryId = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f]/u.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error(`${label}无效。`);
    return value;
};
const integer = (value, min, max, label) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${label}需为 ${min}–${max} 的整数。`);
    return value;
};
const nonzero = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0 || Math.abs(value) > 1000000000 || Math.round(value * 1000000) / 1000000 !== value) throw Error('每周期增减量需为非零有限数，最多六位小数。');
    return value;
};
const exactKeys = (value, keys, label) => {
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error(`${label}含不支持的字段。`);
};

export function validateStacking(input) {
    exactKeys(input, ['mode', 'key', 'maxStacks', 'stacks'], '叠加规则');
    if (!['independent', 'refresh', 'stack'].includes(input.mode)) throw Error('请选择独立、刷新或叠层。');
    const rule = { mode: input.mode, key: id(input.key, '状态类型编号'), maxStacks: integer(input.maxStacks ?? 1, 1, 100, '最大层数'), stacks: integer(input.stacks ?? 1, 1, 100, '当前层数') };
    if (rule.stacks > rule.maxStacks || rule.mode !== 'stack' && (rule.stacks !== 1 || rule.maxStacks !== 1)) throw Error('独立／刷新模式只能有一层；当前层数不能超过上限。');
    return rule;
}

export function validatePeriodicConfig(input) {
    exactKeys(input, ['intervalMinutes', 'operations', 'scaleWithStacks'], '周期规则');
    const intervalMinutes = integer(input.intervalMinutes, 1, 5256000, '结算间隔分钟');
    if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 12) throw Error('每个效果需配置 1–12 个周期操作。');
    if (typeof (input.scaleWithStacks ?? false) !== 'boolean') throw Error('按层数结算设置无效。');
    const operations = input.operations.map(operation => {
        if (operation?.kind === 'stat') {
            exactKeys(operation, ['kind', 'characterId', 'statId', 'delta'], '属性周期操作');
            return { kind: 'stat', characterId: id(operation.characterId, '人物编号'), statId: id(operation.statId, '属性编号'), delta: nonzero(operation.delta) };
        }
        if (operation?.kind === 'item') {
            exactKeys(operation, ['kind', 'itemId', 'quantity'], '物品周期操作');
            return { kind: 'item', itemId: inventoryId(operation.itemId, '物品编号'), quantity: integer(operation.quantity, 1, 1000000000, '每周期物品消耗') };
        }
        if (operation?.kind === 'balance') {
            exactKeys(operation, ['kind', 'balanceId', 'delta'], '资源周期操作');
            return { kind: 'balance', balanceId: inventoryId(operation.balanceId, '资源编号'), delta: nonzero(operation.delta) };
        }
        throw Error('周期操作只支持绑定属性、背包物品与资源账户。');
    });
    return { intervalMinutes, scaleWithStacks: input.scaleWithStacks ?? false, operations };
}

export const periodicConfig = periodic => validatePeriodicConfig({ intervalMinutes: periodic.intervalMinutes, operations: periodic.operations, scaleWithStacks: periodic.scaleWithStacks });

export function validatePeriodic(input) {
    if (!object(input) || input.version !== 1) throw Error('效果周期数据版本不兼容。');
    const config = periodicConfig(input), startedAt = validateClock(input.startedAt);
    const result = { version: 1, ...config, startedAt, elapsedMinutes: integer(input.elapsedMinutes, 0, Number.MAX_SAFE_INTEGER, '周期累计分钟'),
        segmentStartedAt: input.segmentStartedAt === null ? null : validateClock(input.segmentStartedAt),
        pausedAt: input.pausedAt == null ? null : validateClock(input.pausedAt),
        settledTicks: integer(input.settledTicks, 0, Number.MAX_SAFE_INTEGER, '已结算周期数'),
        lastSettledAt: input.lastSettledAt == null ? null : validateClock(input.lastSettledAt) };
    if ((result.segmentStartedAt === null) !== (result.pausedAt !== null)) throw Error('周期暂停时刻与计时状态不一致。');
    for (const value of [result.segmentStartedAt, result.pausedAt, result.lastSettledAt]) {
        if (value && calendarKey(value) !== calendarKey(startedAt)) throw Error('周期记录使用了不同历法。');
        if (value && clockMinutes(value) < clockMinutes(startedAt)) throw Error('周期时刻不能早于规则生效时刻。');
    }
    if (!!result.settledTicks !== !!result.lastSettledAt) throw Error('周期结算次数与已结算剧情时刻不一致。');
    return result;
}

export function createPeriodic(config, clock, paused = false) {
    const startedAt = validateClock(clock);
    return validatePeriodic({ version: 1, ...validatePeriodicConfig(config), startedAt, elapsedMinutes: 0,
        segmentStartedAt: paused ? null : startedAt, pausedAt: paused ? startedAt : null, settledTicks: 0, lastSettledAt: null });
}

// Reading status never settles a tick. A high-water mark is stored only by an
// explicitly confirmed settlement, so prompt reads and time advances are pure.
export function periodicStatus(effect, clock) {
    if (!effect.periodic) return { state: 'none', pendingTicks: 0, totalTicks: 0, elapsedMinutes: 0, label: '无周期规则' };
    const periodic = validatePeriodic(effect.periodic);
    if (!!effect.paused !== (periodic.segmentStartedAt === null)) throw Error('周期规则与效果暂停状态不一致。');
    if (!clock) return { state: 'unknown', pendingTicks: 0, label: '游戏时间未设置，无法预览周期结算。' };
    if (calendarKey(clock) !== calendarKey(periodic.startedAt)) return { state: 'unknown', pendingTicks: 0, label: '游戏历法与周期规则不同，请恢复匹配的时间与效果存档。' };
    const now = clockMinutes(clock), segment = periodic.segmentStartedAt && clockMinutes(periodic.segmentStartedAt);
    if (now < clockMinutes(periodic.startedAt) || segment !== null && now < segment || periodic.lastSettledAt && now < clockMinutes(periodic.lastSettledAt)) return { state: 'unknown', pendingTicks: 0, label: '当前游戏时间早于周期记录或上次结算，请核对剧情时刻。' };
    let elapsedMinutes = periodic.elapsedMinutes + (segment === null ? 0 : now - segment);
    if (effect.timing) {
        const timing = timingStatus(effect, clock);
        if (timing.state === 'unknown') return { state: 'unknown', pendingTicks: 0, label: timing.label };
        elapsedMinutes = Math.max(0, elapsedMinutes - Math.max(0, timing.elapsedMinutes - effect.timing.durationMinutes));
    }
    const totalTicks = Math.floor(elapsedMinutes / periodic.intervalMinutes);
    if (totalTicks < periodic.settledTicks) return { state: 'unknown', pendingTicks: 0, label: '当前累计时间小于已结算周期，请恢复匹配的时间与效果存档。' };
    const pendingTicks = totalTicks - periodic.settledTicks;
    return { state: pendingTicks ? 'pending' : effect.paused ? 'paused' : 'current', elapsedMinutes, totalTicks, pendingTicks,
        label: pendingTicks ? `待结算 ${pendingTicks} 个周期（每 ${periodic.intervalMinutes} 游戏分钟）` : `每 ${periodic.intervalMinutes} 游戏分钟 · 已结算 ${periodic.settledTicks} 次` };
}

export function pausePeriodic(effect, clock, paused) {
    const periodic = validatePeriodic(effect.periodic), status = periodicStatus(effect, clock);
    if (status.state === 'unknown') throw Error(status.label);
    if (paused === !!effect.paused) return periodic;
    const at = validateClock(clock);
    if (periodic.pausedAt && clockMinutes(at) < clockMinutes(periodic.pausedAt)) throw Error('当前游戏时间早于周期暂停时刻。');
    return validatePeriodic({ ...periodic, elapsedMinutes: status.elapsedMinutes, segmentStartedAt: paused ? null : at, pausedAt: paused ? at : null });
}

export function requireSettledBeforeReset(effect, clock) {
    if (!effect.periodic) return;
    const status = periodicStatus(effect, clock);
    if (status.state === 'unknown') throw Error(status.label);
    if (status.pendingTicks) throw Error('此效果仍有待结算周期，请先预览并确认结算，再刷新、叠层或重设规则。');
}
