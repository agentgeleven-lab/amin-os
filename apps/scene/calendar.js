const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label}需为 ${min}–${max} 的整数。`); return value; };
const label = (value, name, max = 80) => { if (typeof value !== 'string' || value.length > max) throw Error(`${name}必须是 ${max} 字以内的文本。`); return value.trim(); };
const DAY = 1440, YEAR_ONE_DAY = -719162;
export const DEFAULT_WEEK = Object.freeze(['日', '一', '二', '三', '四', '五', '六']);

// The calendar travels with every timestamp: changing today's calendar never reinterprets history.
export function validateCalendar(input) {
    if (!object(input) || !Array.isArray(input.monthLengths) || input.monthLengths.length < 1 || input.monthLengths.length > 24) throw Error('自定义历法需有 1–24 个月。');
    const monthLengths = input.monthLengths.map(value => integer(value, 1, 100, '每月天数'));
    const names = input.monthNames ?? monthLengths.map((_, index) => `${index + 1}月`);
    if (!Array.isArray(names) || names.length !== monthLengths.length) throw Error('月份名称数量须与月长一致。');
    const monthNames = names.map(value => label(value, '月份名称', 30));
    const rawWeek = input.weekDays ?? [...DEFAULT_WEEK];
    if (!Array.isArray(rawWeek) || rawWeek.length < 1 || rawWeek.length > 14) throw Error('每周需有 1–14 天。');
    const weekDays = rawWeek.map(value => label(value, '星期名称', 30));
    if ([...monthNames, ...weekDays].some(value => !value)) throw Error('月份和星期名称不能为空。');
    return { monthLengths, monthNames, weekDays, epochWeekday: integer(input.epochWeekday ?? 0, 0, weekDays.length - 1, '元年首日星期') };
}
function dateFrom(clock) {
    const date = new Date(0);
    date.setUTCHours(clock.hour, clock.minute, 0, 0);
    date.setUTCFullYear(clock.year, clock.month - 1, clock.day);
    return date;
}
export function validateGameClock(input) {
    if (!object(input)) throw Error('请先设置游戏日期与时间。');
    const calendar = input.calendar == null ? null : validateCalendar(input.calendar);
    const clock = {
        year: integer(input.year, 1, 9999, '年份'), month: integer(input.month, 1, calendar?.monthLengths.length ?? 12, '月份'),
        day: integer(input.day, 1, calendar?.monthLengths[input.month - 1] ?? 31, '日期'),
        hour: integer(input.hour, 0, 23, '小时'), minute: integer(input.minute, 0, 59, '分钟'), calendarLabel: label(input.calendarLabel ?? '', '历法名称'),
    };
    if (calendar) clock.calendar = calendar;
    else {
        const date = dateFrom(clock);
        if (date.getUTCFullYear() !== clock.year || date.getUTCMonth() + 1 !== clock.month || date.getUTCDate() !== clock.day) throw Error('该年月中不存在这个日期。日期采用公历月长与闰年规则。');
    }
    return clock;
}
export function gameTimeMinutes(input) {
    const clock = validateGameClock(input), calendar = clock.calendar;
    if (!calendar) return dateFrom(clock).getTime() / 60000;
    const days = (clock.year - 1) * calendar.monthLengths.reduce((sum, value) => sum + value, 0)
        + calendar.monthLengths.slice(0, clock.month - 1).reduce((sum, value) => sum + value, 0) + clock.day - 1;
    return (YEAR_ONE_DAY + days) * DAY + clock.hour * 60 + clock.minute;
}
export function advanceGameClock(input, minutes) {
    const clock = validateGameClock(input);
    integer(minutes, 1, 5256000, '推进分钟数');
    if (!clock.calendar) {
        const date = new Date((gameTimeMinutes(clock) + minutes) * 60000);
        return validateGameClock({ ...clock, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() });
    }
    const total = gameTimeMinutes(clock) + minutes - YEAR_ONE_DAY * DAY, days = Math.floor(total / DAY);
    const yearLength = clock.calendar.monthLengths.reduce((sum, value) => sum + value, 0);
    let remaining = days % yearLength, month = 0;
    while (remaining >= clock.calendar.monthLengths[month]) remaining -= clock.calendar.monthLengths[month++];
    return validateGameClock({ ...clock, year: Math.floor(days / yearLength) + 1, month: month + 1, day: remaining + 1, hour: Math.floor(total % DAY / 60), minute: total % 60 });
}
export function clockWeekday(input) {
    const clock = validateGameClock(input);
    if (!clock.calendar) return { index: dateFrom(clock).getUTCDay(), names: [...DEFAULT_WEEK] };
    const days = Math.floor(gameTimeMinutes(clock) / DAY) - YEAR_ONE_DAY;
    return { index: (days + clock.calendar.epochWeekday) % clock.calendar.weekDays.length, names: [...clock.calendar.weekDays] };
}
export const calendarKey = clock => JSON.stringify(clock?.calendar ? validateCalendar(clock.calendar) : null);
