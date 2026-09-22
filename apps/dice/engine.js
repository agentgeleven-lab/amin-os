// All randomness is local. No host macros, script evaluation or model requests.
export const LIMITS = Object.freeze({ formula: 160, terms: 24, dice: 100, sides: 1000000, modifier: 1000000, batch: 20, batchDice: 400, presets: 60 });
const integer = (value, min, max, label) => {
    if (value === '' || value === null || value === undefined || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw Error(`${label}需为 ${min}–${max} 的整数。`);
    return Number(value);
};
const choice = (value, allowed, fallback, label) => { const next = value ?? fallback; if (!allowed.includes(next)) throw Error(`${label}不受支持。`); return next; };
export function randomInt(sides, cryptoSource = globalThis.crypto) {
    integer(sides, 1, LIMITS.sides, '骰面');
    if (typeof cryptoSource?.getRandomValues !== 'function') throw Error('当前浏览器不支持安全随机数，无法掷骰。');
    const range = 0x100000000, cutoff = range - range % sides, buffer = new Uint32Array(1);
    // Rejection sampling removes the modulo bias for non-power-of-two dice.
    for (let attempt = 0; attempt < 128; attempt++) { cryptoSource.getRandomValues(buffer); if (buffer[0] < cutoff) return buffer[0] % sides + 1; }
    throw Error('随机数源持续返回无效区间，请重试。');
}
export function parseFormula(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > LIMITS.formula) throw Error(`公式需为 1–${LIMITS.formula} 个字符。`);
    const source = raw.replace(/\s+/g, '').toLowerCase();
    if (!/^[0-9dkhl+\-]+$/.test(source)) throw Error('支持 NdS、kh/kl 保留骰以及整数加减，例如 2d6+3 或 4d6kh3。');
    const terms = []; let offset = 0, diceCount = 0;
    while (offset < source.length) {
        const match = /^([+-]?)(?:(\d*)d(\d+)(?:(kh|kl)(\d+))?|(\d+))/.exec(source.slice(offset));
        if (!match || (offset > 0 && !match[1])) throw Error('公式格式错误：各项之间需要 + 或 -。');
        const sign = match[1] === '-' ? -1 : 1;
        if (match[3]) {
            const count = integer(match[2] || 1, 1, LIMITS.dice, '骰数'), sides = integer(match[3], 2, LIMITS.sides, '骰面');
            const keep = match[4] ? integer(match[5], 1, count, '保留骰数') : count;
            terms.push({ type: 'dice', sign, count, sides, keep, keepMode: match[4] || '' }); diceCount += count;
        } else terms.push({ type: 'constant', sign, value: integer(match[6], 0, LIMITS.modifier, '修正值') });
        if (terms.length > LIMITS.terms || diceCount > LIMITS.dice) throw Error(`每条公式最多 ${LIMITS.terms} 项、${LIMITS.dice} 枚骰子。`);
        offset += match[0].length;
    }
    if (!diceCount) throw Error('公式至少需要一枚骰子。');
    const formula = terms.map((t, i) => `${t.sign < 0 ? '-' : i ? '+' : ''}${t.type === 'dice' ? `${t.count}d${t.sides}${t.keepMode ? t.keepMode + t.keep : ''}` : t.value}`).join('');
    return { formula, terms, diceCount };
}
function die(sides, rng) { return integer(rng(sides), 1, sides, '随机骰点'); }
export function evaluateFormula(parsed, rng = randomInt) {
    if (typeof parsed === 'string') parsed = parseFormula(parsed);
    let total = 0;
    const terms = parsed.terms.map(term => {
        if (term.type === 'constant') { total += term.sign * term.value; return { ...term, subtotal: term.value }; }
        const rolls = Array.from({ length: term.count }, () => die(term.sides, rng));
        const ranked = rolls.map((value, index) => ({ value, index }));
        if (term.keepMode) ranked.sort((a, b) => term.keepMode === 'kh' ? b.value - a.value || a.index - b.index : a.value - b.value || a.index - b.index);
        const kept = ranked.slice(0, term.keep).map(v => v.index).sort((a, b) => a - b), subtotal = kept.reduce((sum, index) => sum + rolls[index], 0);
        total += term.sign * subtotal; return { ...term, rolls, kept, subtotal };
    });
    const breakdown = terms.map((t, i) => `${t.sign < 0 ? '− ' : i ? '+ ' : ''}${t.type === 'dice' ? `${t.count}d${t.sides}${t.keepMode ? t.keepMode + t.keep : ''} [${t.rolls.map((v, j) => t.kept.includes(j) ? v : `(${v}舍弃)`).join(', ')}]` : t.value}`).join(' ');
    return { formula: parsed.formula, terms, total, breakdown };
}
export function normalizeConfig(input = {}) {
    const mode = choice(input.mode, ['generic', 'dnd', 'coc'], 'generic', '规则');
    const label = String(input.label ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (label.length > 80 || /\{\{|\}\}/.test(label)) throw Error('判定名称最多 80 字，不能包含酒馆宏。');
    const batch = integer(input.batch ?? 1, 1, LIMITS.batch, '重复次数');
    if (mode === 'generic') {
        const parsed = parseFormula(input.formula ?? '1d20');
        if (parsed.diceCount * batch > LIMITS.batchDice) throw Error(`单次批量最多掷 ${LIMITS.batchDice} 枚骰子。`);
        return { mode, label, batch, formula: parsed.formula };
    }
    if (mode === 'dnd') return { mode, label, batch, advantage: choice(input.advantage, ['normal', 'advantage', 'disadvantage'], 'normal', '优劣势'), modifier: integer(input.modifier ?? 0, -10000, 10000, '修正值'), dc: input.dc === '' || input.dc === null || input.dc === undefined ? null : integer(input.dc, -10000, 10000, 'DC / AC'), critical: choice(input.critical, ['check', 'attack', 'house'], 'check', '自然骰规则') };
    return { mode, label, batch, skill: integer(input.skill ?? 50, 1, 999, '技能值'), bonus: integer(input.bonus ?? 0, 0, 2, '奖励骰'), penalty: integer(input.penalty ?? 0, 0, 2, '惩罚骰'), difficulty: choice(input.difficulty, ['regular', 'hard', 'extreme'], 'regular', '难度') };
}
export function rollDnd(config, rng = randomInt) {
    const c = normalizeConfig({ ...config, mode: 'dnd' });
    const dice = Array.from({ length: c.advantage === 'normal' ? 1 : 2 }, () => die(20, rng));
    const natural = c.advantage === 'disadvantage' ? Math.min(...dice) : Math.max(...dice), total = natural + c.modifier;
    let success = c.dc === null ? null : total >= c.dc;
    if (c.critical !== 'check' && [1, 20].includes(natural)) success = natural === 20;
    const naturalLabel = natural === 20 ? (c.critical === 'attack' ? '自然20 · 重击' : '自然20') : natural === 1 ? (c.critical === 'attack' ? '自然1 · 未命中' : '自然1') : '';
    const verdict = success === null ? '未设置目标值' : success ? '成功' : '失败';
    const advantageLabel = { normal: '普通', advantage: '优势取高', disadvantage: '劣势取低' }[c.advantage];
    return { formula: `1d20${c.modifier < 0 ? '' : '+'}${c.modifier}`, dice, natural, total, success, naturalLabel, verdict, breakdown: `D20 ${advantageLabel} [${dice.join(', ')}] → ${natural} ${c.modifier < 0 ? '−' : '+'} ${Math.abs(c.modifier)} = ${total}${c.dc === null ? '' : `；目标 ${c.dc}`}；${[naturalLabel, verdict].filter(Boolean).join('；')}` };
}
export function percentile(tens, units) { integer(tens, 0, 9, '十位'); integer(units, 0, 9, '个位'); return tens * 10 + units || 100; }
export function cocOutcome(value, skill, difficulty = 'regular') {
    integer(value, 1, 100, '百分骰'); integer(skill, 1, 999, '技能值');
    choice(difficulty, ['regular', 'hard', 'extreme'], 'regular', '难度');
    const thresholds = { regular: skill, hard: Math.floor(skill / 2), extreme: Math.floor(skill / 5) }, target = thresholds[difficulty];
    // CoC 7e uses the required success chance for the fumble boundary.
    const fumble = value === 100 || (target < 50 && value >= 96);
    const level = value === 1 ? 'critical' : fumble ? 'fumble' : value <= thresholds.extreme ? 'extreme' : value <= thresholds.hard ? 'hard' : value <= thresholds.regular ? 'regular' : 'failure';
    const success = level === 'critical' || (!fumble && value <= target);
    return { level, success, target, thresholds, verdict: { critical: '大成功', extreme: '极难成功', hard: '困难成功', regular: '普通成功', failure: '失败', fumble: '大失败' }[level] };
}
export function rollCoc(config, rng = randomInt) {
    const c = normalizeConfig({ ...config, mode: 'coc' }), net = c.bonus - c.penalty;
    const units = die(10, rng) - 1, tens = Array.from({ length: 1 + Math.abs(net) }, () => die(10, rng) - 1);
    const candidates = tens.map(value => percentile(value, units)), total = net > 0 ? Math.min(...candidates) : net < 0 ? Math.max(...candidates) : candidates[0];
    const outcome = cocOutcome(total, c.skill, c.difficulty), selection = net > 0 ? `奖励${net}取低` : net < 0 ? `惩罚${-net}取高` : '普通';
    const diceText = `个位 ${units}；十位 [${tens.map(v => v ? v + '0' : '00').join(', ')}]；候选 [${candidates.join(', ')}]`;
    return { formula: '1d100', units, tens, candidates, net, total, ...outcome, breakdown: `D100 ${selection}：${diceText} → ${total}；技能 ${c.skill}，${{ regular: '普通', hard: '困难', extreme: '极难' }[c.difficulty]}目标 ${outcome.target}；${outcome.verdict}${outcome.success ? ' · 达成目标' : ' · 未达目标'}` };
}
export function rollBatch(config, rng = randomInt) {
    const settings = normalizeConfig(config), parsed = settings.mode === 'generic' ? parseFormula(settings.formula) : null;
    return { settings, results: Array.from({ length: settings.batch }, () => settings.mode === 'generic' ? evaluateFormula(parsed, rng) : settings.mode === 'dnd' ? rollDnd(settings, rng) : rollCoc(settings, rng)) };
}
export function formatRoll(record) {
    const label = record.settings.label || { generic: '通用掷骰', dnd: 'D&D 判定', coc: 'CoC 7 判定' }[record.settings.mode];
    const lines = record.results.map((r, index) => `${record.results.length > 1 ? `${index + 1}. ` : ''}${r.breakdown}${record.settings.mode === 'generic' ? ` = ${r.total}` : ''}`);
    return `【骰子 · ${label} · #${record.id.replace(/-/g, '').slice(0, 12)}】\n${lines.join('\n')}`;
}
