import { readCharacters, resolveStat } from '../characters/model.js';
import { normalizeConfig } from '../dice/engine.js';
import { getSharedDiceService } from '../dice/service.js';
import { readCurrentScene } from '../scene/model.js';
import { anchor, consumedActionIds, readStore } from './model.js';
import { getSharedService } from './service.js';

const copy = value => structuredClone(value);
const stamp = value => JSON.stringify(value);
const rollStamp = record => stamp([record.id, record.createdAt, record.settings, record.results, record.text, record.rerollOf]);
const chatId = ctx => stamp([ctx?.getCurrentChatId?.() ?? ctx?.chatId, ctx?.characterId, ctx?.groupId]);
const integer = (value, label) => {
    if (value === '' || value === null || value === undefined || !Number.isSafeInteger(Number(value))) throw Error(`${label}必须是整数。`);
    return Number(value);
};
function selectionData(selection, actor) {
    const mode = selection?.targetMode ?? 'targeted';
    if (!['targeted', 'direct'].includes(mode)) throw Error('请选择有效的发动方式。');
    const text = (value, label, required = true) => {
        if (typeof value !== 'string' || value.length > 4000 || required && !value.trim()) throw Error(`请填写有效的${label}（最多 4000 字）。`);
        return value.trim();
    };
    const duration = selection.durationMinutes === '' || selection.durationMinutes == null ? null : integer(selection.durationMinutes, '持续分钟数');
    if (duration !== null && (duration < 1 || duration > 5256000)) throw Error('持续分钟数需为 1–5256000。');
    return {
        skillId: selection.skillId, holder: actor.name, targetMode: mode,
        target: mode === 'direct' ? '' : text(selection.target, '目标'),
        scope: text(selection.scope, '作用层面'), command: text(selection.command ?? '', '具体指令', false),
        condition: text(selection.condition, '持续或解除条件'), durationMinutes: duration,
    };
}

// Bound values are read from World Status at preview time. Rule conversion is an
// explicit choice; an attribute score is never silently treated as a modifier.
export function buildCheckConfig(resolved, skill, options = {}) {
    const extra = integer(options.modifier ?? 0, '额外修正');
    const label = `${resolved.character.name} · ${skill.name} · ${resolved.label}`;
    if (options.mode === 'coc') {
        const base = integer(resolved.value, '绑定技能值');
        return normalizeConfig({ mode: 'coc', label, batch: 1, skill: base + extra,
            difficulty: options.difficulty ?? 'regular', bonus: options.bonus ?? 0, penalty: options.penalty ?? 0 });
    }
    if (options.mode !== 'd20') throw Error('请选择 D20 或 CoC 7 检定。');
    if (!['modifier', 'score'].includes(options.valueMode ?? 'modifier')) throw Error('请选择绑定值作为调整值或属性值。');
    const value = integer(resolved.value, '绑定属性值');
    const base = options.valueMode === 'score' ? Math.floor((value - 10) / 2) : value;
    return normalizeConfig({ mode: 'dnd', label, batch: 1, modifier: base + extra, dc: options.dc,
        advantage: options.advantage ?? 'normal', critical: options.critical ?? 'check' });
}

export function createAbilityCheckService(getContext = () => globalThis.SillyTavern?.getContext?.(), { dice = getSharedDiceService(getContext), effects = getSharedService() } = {}) {
    let pending = null, busy = false, disposed = false, message = '选择人物与绑定属性，先预览检定。';
    const listeners = new Set();
    const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* A view cannot interrupt a saved roll. */ } } };
    function boundary(item = pending) {
        const ctx = getContext();
        if (!item || ctx?.chatMetadata !== item.meta || chatId(ctx) !== item.chatId || stamp(anchor(ctx.chat)) !== item.path) throw Error('聊天、楼层或候选已变化，请重新预览检定。');
        return ctx;
    }
    function check(item = pending) {
        const ctx = boundary(item);
        if (item.invalidated) throw Error(item.invalidated);
        const skill = readStore(ctx).skills.find(entry => entry.id === item.selection.skillId);
        if (!skill || stamp(skill) !== item.skillStamp) throw Error('能力规则已变化，请重新预览检定。');
        const resolved = resolveStat(ctx, item.characterId, item.statId);
        if (stamp(resolved) !== item.statStamp) throw Error('人物、属性绑定或当前数值已变化，请重新预览检定。');
        if (item.selection.durationMinutes !== null && stamp(readCurrentScene(ctx).clock) !== item.clockStamp) throw Error('游戏时间已变化，请重新预览持续时间和检定。');
        if (item.record) {
            const stored = dice.history().find(record => record.id === item.record.id);
            if (!stored || rollStamp(stored) !== rollStamp(item.record)) throw Error('固定骰点记录已变化或不存在，请到骰子历史检查后重新预览。');
        }
        return ctx;
    }
    const findRoll = item => item?.record && dice.history().find(record => record.id === item.record.id);
    function preview() {
        if (!pending) return null;
        let error = '';
        try { check(pending); if (pending.record) pending.applied = actionExists(pending); } catch (e) { error = e.message; }
        const record = error ? pending.record : findRoll(pending) ?? pending.record;
        return { ...copy(pending.public), record: record ? copy(record) : null, applied: pending.applied, stale: !!error, error, dirty: !error && !!dice.dirty?.(), effectDirty: !error && !!effects.dirty?.() };
    }
    function stage(selection, options) {
        if (busy) throw Error('正在处理检定，请稍候。');
        const ctx = getContext();
        if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) throw Error('请先打开一个聊天。');
        const resolved = resolveStat(ctx, options?.characterId, options?.statId);
        const skill = readStore(ctx).skills.find(entry => entry.id === selection?.skillId);
        if (!skill) throw Error('所选能力已不存在，请重新选择。');
        const normalized = selectionData(selection, resolved.character), config = buildCheckConfig(resolved, skill, options);
        const clock = normalized.durationMinutes === null ? null : readCurrentScene(ctx).clock;
        if (normalized.durationMinutes !== null && !clock) throw Error('请先在场景与时间中设置游戏时间，再使用限时效果。');
        pending = { meta: ctx.chatMetadata, chatId: chatId(ctx), path: stamp(anchor(ctx.chat)),
            characterId: resolved.character.id, statId: resolved.stat.id, selection: normalized,
            skillStamp: stamp(skill), statStamp: stamp(resolved), clockStamp: stamp(clock), config,
            record: null, applied: false, invalidated: '', public: {
                character: copy(resolved.character), stat: copy(resolved.stat), value: resolved.value,
                skill: copy(skill), config: copy(config), selection: copy(normalized), options: copy(options), clock: copy(clock),
            } };
        message = '已读取当前世界状态。确认规则后掷骰，结果将固定保存。'; notify(); return preview();
    }
    async function roll() {
        if (busy) throw Error('正在处理检定，请稍候。');
        check(); const item = pending;
        if (item.record) throw Error('本次结果已固定。需要再次检定时，请先建立新预览。');
        const before = new Set(dice.history().map(record => record.id)); busy = true; notify();
        try {
            item.record = await dice.roll(item.config); check(item);
            message = '结果已固定；可追加到草稿。效果需要另行确认，数值不会自动修改。'; return copy(item.record);
        } catch (error) {
            // Dice service deliberately retains a fixed result when disk saving
            // fails. Recover that exact record so retry never consumes new dice.
            try { boundary(item); item.record ??= dice.history().find(record => !before.has(record.id) && stamp(record.settings) === stamp(item.config)) ?? null; } catch { /* The previous chat owns its result. */ }
            message = error.message; throw error;
        } finally { busy = false; notify(); }
    }
    async function append(input = globalThis.document?.querySelector('#send_textarea')) {
        if (busy) throw Error('正在处理检定，请稍候。');
        check(); const item = pending, record = findRoll(item), expectedDraft = input?.value;
        if (!record) throw Error('请先完成本次检定。');
        busy = true; notify();
        try {
            if (dice.dirty?.()) await dice.retrySave();
            check(item);
            if (input?.value !== expectedDraft) throw Error('草稿已改变，请检查当前内容后再次追加。');
            await dice.append(record.id, input); check(item);
            message = '已追加固定骰点。请使用聊天发送按钮，与行动正文一起发出。';
        } catch (error) { message = error.message; throw error; }
        finally { busy = false; notify(); }
    }
    function actionExists(item) {
        const ctx = boundary(item), actionId = `ability-check:${item.record.id}`;
        // A restored snapshot defines current consumption. Earlier events stay
        // available to their historical branch but cannot override the restore.
        return consumedActionIds(readStore(ctx), ctx.chat).includes(actionId);
    }
    async function apply() {
        if (busy) throw Error('正在处理检定，请稍候。');
        check(); const item = pending;
        if (!findRoll(item)) throw Error('请先完成本次检定。');
        item.applied = actionExists(item);
        if (item.applied) throw Error('这个固定结果已经确认过效果，不能重复发动。');
        if (dice.dirty?.()) throw Error('骰点尚未保存，请先重试保存固定结果。');
        if (typeof effects.mutate !== 'function') throw Error('当前能力服务缺少检定后确认接口，请刷新扩展。');
        const token = effects.capture(); busy = true; notify();
        try {
            await effects.mutate(token, 'create', { ...copy(item.selection), actionId: `ability-check:${item.record.id}` });
            item.applied = true; boundary(item); message = '已按你的确认建立持续效果；人物数值未自动修改。';
            return { rollId: item.record.id, selection: copy(item.selection) };
        } catch (error) {
            try { item.applied = actionExists(item); } catch { /* Never inspect a replacement chat as the old result. */ }
            message = error.message; throw error;
        } finally { busy = false; notify(); }
    }
    async function retrySave() {
        if (busy) throw Error('正在处理检定，请稍候。');
        const item = pending; boundary(item); busy = true; notify();
        try {
            if (dice.dirty?.()) await dice.retrySave();
            else if (effects.dirty?.() && typeof effects.retrySave === 'function') await effects.retrySave();
            else throw Error('没有需要重试的保存。');
            boundary(item); message = '已重试保存，固定骰点与效果均未重复执行。';
        } catch (error) { message = error.message; throw error; }
        finally { busy = false; notify(); }
    }
    const removers = [dice.subscribe?.(notify), effects.subscribe?.(notify)].filter(Boolean);
    return { stage, preview, roll, append, apply, retrySave, check, context: getContext,
        characters: () => readCharacters(getContext()).characters,
        resolve: (characterId, statId) => resolveStat(getContext(), characterId, statId),
        invalidate(reason = '检定选项或发动资料已变化，请重新预览。') { if (pending) pending.invalidated = reason; notify(); },
        discard() { if (busy) throw Error('正在处理检定，请稍候。'); pending = null; notify(); },
        busy: () => busy || !!dice.busy?.(), status: () => message,
        subscribe(fn) { if (disposed) return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
        dispose() { disposed = true; removers.forEach(remove => remove()); listeners.clear(); pending = null; },
    };
}
