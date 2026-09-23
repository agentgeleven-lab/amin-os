import { validateClock, gameTimeMinutes, calendarKey } from '../scene/model.js';

export const MAX_DURATION_MINUTES = 5256000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const duration = value => {
    if (!Number.isInteger(value) || value < 1 || value > MAX_DURATION_MINUTES) throw Error(`持续分钟数需为 1–${MAX_DURATION_MINUTES} 的整数。`);
    return value;
};

// The scene clock is a game calendar. A real save timestamp is never a substitute.
export function clockMinutes(input) {
    return gameTimeMinutes(validateClock(input));
}

export function validateTiming(input) {
    if (!object(input) || input.version !== 1) throw Error('效果计时数据版本或格式不兼容，原记录未改写。');
    const elapsedMinutes = input.elapsedMinutes;
    if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes < 0) throw Error('效果已用游戏分钟数无效。');
    const timing = {
        version: 1, durationMinutes: duration(input.durationMinutes),
        startedAt: validateClock(input.startedAt), elapsedMinutes,
        segmentStartedAt: input.segmentStartedAt === null ? null : validateClock(input.segmentStartedAt),
        pausedAt: input.pausedAt == null ? null : validateClock(input.pausedAt),
    };
    if ([timing.segmentStartedAt, timing.pausedAt].some(value => value && calendarKey(value) !== calendarKey(timing.startedAt))) throw Error('效果计时记录使用了不同历法。');
    if (timing.segmentStartedAt && clockMinutes(timing.segmentStartedAt) < clockMinutes(timing.startedAt)) throw Error('效果计时片段不能早于发动时刻。');
    if ((timing.segmentStartedAt === null) !== (timing.pausedAt !== null)) throw Error('效果暂停时刻与计时片段不一致。');
    if (timing.pausedAt && clockMinutes(timing.pausedAt) < clockMinutes(timing.startedAt)) throw Error('效果暂停时刻不能早于发动时刻。');
    return timing;
}

export function createTiming(durationMinutes, clock, { paused = false } = {}) {
    const startedAt = validateClock(clock);
    return validateTiming({ version: 1, durationMinutes, startedAt, elapsedMinutes: 0, segmentStartedAt: paused ? null : startedAt, pausedAt: paused ? startedAt : null });
}

export function timingStatus(effect, clock) {
    if (!effect.timing) return { state: effect.paused ? 'paused' : 'untimed', remainingMinutes: null, elapsedMinutes: null, label: effect.paused ? '已暂停 · 无游戏计时' : '按文字条件持续' };
    const timing = validateTiming(effect.timing);
    if (effect.paused && timing.segmentStartedAt !== null || !effect.paused && timing.segmentStartedAt === null) throw Error('效果暂停状态与计时记录不一致，原记录未改写。');
    if (clock && calendarKey(clock) !== calendarKey(timing.startedAt)) return { state: 'unknown', remainingMinutes: null, elapsedMinutes: timing.elapsedMinutes, label: '游戏历法已改变，请核对时间并明确重设效果时长' };
    let elapsedMinutes = timing.elapsedMinutes;
    if (timing.segmentStartedAt) {
        if (!clock) return { state: 'unknown', remainingMinutes: null, elapsedMinutes, label: '游戏时间未设置 · 暂不附加此效果提醒' };
        const delta = clockMinutes(clock) - clockMinutes(timing.segmentStartedAt);
        if (delta < 0) return { state: 'unknown', remainingMinutes: null, elapsedMinutes, label: '当前游戏时间早于计时片段 · 请核对时间或重设持续时间' };
        elapsedMinutes += delta;
    }
    const remainingMinutes = Math.max(0, timing.durationMinutes - elapsedMinutes);
    if (remainingMinutes === 0) return { state: 'expired', remainingMinutes, elapsedMinutes, label: '已到期 · 不再附加剧情提醒' };
    return {
        state: effect.paused ? 'paused' : 'active', remainingMinutes, elapsedMinutes,
        label: effect.paused ? `已暂停 · 剩余 ${remainingMinutes} 游戏分钟（计时冻结）` : `剩余 ${remainingMinutes} 游戏分钟`,
    };
}

export function pauseTiming(effect, clock, paused) {
    if (!effect.timing) return undefined;
    const timing = validateTiming(effect.timing), status = timingStatus(effect, clock);
    if (status.state === 'expired') throw Error('效果已到期，请明确重设持续时间或解除记录。');
    if (paused === !!effect.paused) return timing;
    if (status.state === 'unknown') throw Error(status.label);
    const at = validateClock(clock);
    if (clockMinutes(at) < clockMinutes(timing.startedAt)) throw Error('当前游戏时间早于效果发动时刻，请核对时间或重设持续时间。');
    if (timing.pausedAt && clockMinutes(at) < clockMinutes(timing.pausedAt)) throw Error('当前游戏时间早于暂停时刻，请核对时间或重设持续时间。');
    return validateTiming({ ...timing, elapsedMinutes: status.elapsedMinutes, segmentStartedAt: paused ? null : at, pausedAt: paused ? at : null });
}
