import { uuid } from '../../uuid.js';

export const KEY = 'amin_os_characters_v1';
export const STATUS_PATH = Object.freeze(['variables', '状态栏']);
export const LIMITS = Object.freeze({ characters: 200, stats: 80, events: 2000, text: 4000, number: Number.MAX_SAFE_INTEGER });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !forbidden.has(value);
const safeName = value => typeof value === 'string' && /^[\p{L}\p{N}_]{1,32}$/u.test(value) && !forbidden.has(value);
const text = (value, name, limit = LIMITS.text) => {
    if (typeof value !== 'string' || value.length > limit) throw Error(`${name}必须是 ${limit} 字以内的文本。`);
    return value.trim();
};
export const emptyState = () => ({ version: 1, characters: [] });
export const emptyStore = () => ({ version: 1, events: [] });
export const chatPath = chat => (chat ?? []).map(message => JSON.stringify([message.name ?? '', !!message.is_user, message.mes ?? '', message.swipe_id ?? 0]));
export const belongs = (event, path) => Array.isArray(event?.path) && event.path.length <= path.length && event.path.every((part, index) => part === path[index]);

export function bindingParts(binding) {
    if (typeof binding !== 'string') throw Error('数值绑定必须填写“项目名.字段名”。');
    const parts = binding.split('.');
    if (parts.length !== 2 || !parts.every(safeName)) throw Error('数值绑定必须填写有效的“项目名.字段名”。');
    return parts;
}
export function validateStat(input) {
    if (!object(input) || !validId(input.id)) throw Error('属性编号无效。');
    const stat = { ...copy(input), id: input.id, label: text(input.label, '属性名称', 80), binding: text(input.binding, '数值绑定', 65) };
    if (!stat.label) throw Error('请填写属性名称。');
    bindingParts(stat.binding);
    if (!['value', 'current', 'max'].includes(stat.component)) throw Error('请选择数字值、当前值或最大值。');
    if (!['none', 'd20', 'coc'].includes(stat.check)) throw Error('属性检定类型无效。');
    // Canonical numbers live only in World Status; reject accidental duplicate state.
    if (Object.hasOwn(input, 'value')) throw Error('属性不能另存数值，请绑定世界状态中的现有字段。');
    return stat;
}
export function validateAppearance(input) {
    if (!object(input) || Object.keys(input).some(key => !['description', 'hairstyle', 'features'].includes(key))) throw Error('人物外观格式无效。');
    return { description: text(input.description ?? '', '整体外观'), hairstyle: text(input.hairstyle ?? '', '发型', 500), features: text(input.features ?? '', '外貌特征', 2000) };
}
export function validateCharacter(input) {
    if (!object(input) || !validId(input.id)) throw Error('人物编号无效。');
    const character = { ...copy(input), id: input.id, name: text(input.name, '人物名称', 120), notes: text(input.notes ?? '', '人物备注') };
    if (!character.name) throw Error('请填写人物名称。');
    if (!['pc', 'npc'].includes(character.kind)) throw Error('请选择 PC 或 NPC。');
    if (!Array.isArray(input.stats) || input.stats.length > LIMITS.stats) throw Error(`每个人物最多保存 ${LIMITS.stats} 项属性。`);
    character.stats = input.stats.map(validateStat);
    if (new Set(character.stats.map(stat => stat.id)).size !== character.stats.length) throw Error('人物属性编号重复。');
    if (input.appearance !== undefined) character.appearance = validateAppearance(input.appearance);
    return character;
}
export function validateState(input) {
    if (!object(input) || input.version !== 1 || !Array.isArray(input.characters) || input.characters.length > LIMITS.characters) throw Error('人物资料格式或版本不兼容，原记录未改写。');
    const state = { ...copy(input), version: 1, characters: input.characters.map(validateCharacter) };
    if (new Set(state.characters.map(character => character.id)).size !== state.characters.length) throw Error('人物编号重复。');
    return state;
}
export function validateStore(input) {
    if (!object(input) || input.version !== 1 || !Array.isArray(input.events) || input.events.length > LIMITS.events) throw Error('人物资料历史格式或版本不兼容，原记录未改写。');
    const seen = new Set();
    for (const event of input.events) {
        if (!object(event) || !validId(event.id) || seen.has(event.id) || typeof event.at !== 'string' || event.at.length > 100 || !Array.isArray(event.path) || event.path.some(part => typeof part !== 'string')) throw Error('人物资料历史记录损坏，原记录未改写。');
        seen.add(event.id); validateState(event.snapshot);
    }
    return copy(input);
}
export function readStore(ctx) {
    const value = ctx?.chatMetadata?.[KEY];
    return value === undefined ? emptyStore() : validateStore(value);
}
export function currentState(store, chat) {
    const value = validateStore(store), path = chatPath(chat);
    for (let index = value.events.length - 1; index >= 0; index--) if (belongs(value.events[index], path)) return validateState(value.events[index].snapshot);
    return emptyState();
}
export const readCharacters = ctx => currentState(readStore(ctx), ctx?.chat);
export const getCharacter = (ctx, id) => readCharacters(ctx).characters.find(character => character.id === id) ?? null;
export function appendSnapshot(store, chat, snapshot, { id = uuid(), at = new Date().toISOString(), reason = '' } = {}) {
    const value = validateStore(store), state = validateState(snapshot);
    if (!validId(id) || value.events.some(event => event.id === id)) throw Error('人物操作编号无效或重复。');
    if (value.events.length >= LIMITS.events) throw Error(`人物操作历史已达 ${LIMITS.events} 条，请先导出存档。`);
    value.events.push({ id, at: text(at, '记录时间', 100), reason: text(reason, '操作说明', 400), path: chatPath(chat), snapshot: state });
    return value;
}
// Cross-app restore appends a materialized state at the CURRENT chat path.
// Older paths stay intact; copying old anchors would restore the wrong branch.
export function buildRestore(ctx, snapshot, options = {}) {
    return appendSnapshot(readStore(ctx), ctx?.chat, validateState(snapshot), { ...options, reason: options.reason ?? '恢复人物存档' });
}
export function readWorldStatus(ctx) {
    const raw = ctx?.chatMetadata?.variables?.状态栏;
    if (raw === undefined || raw === null || raw === '') throw Error('世界状态尚未建立，请先创建要绑定的数值字段。');
    let state;
    try { state = typeof raw === 'string' ? JSON.parse(raw) : copy(raw); } catch { throw Error('世界状态数据无法解析，原记录未改写。'); }
    if (!object(state) || state.版本 !== 1 || !object(state.项目)) throw Error('世界状态格式或版本不兼容，原记录未改写。');
    return state;
}
function boundValue(state, binding, component) {
    const [project, field] = bindingParts(binding);
    if (!Object.hasOwn(state.项目, project) || !object(state.项目[project]) || !Object.hasOwn(state.项目[project], field)) throw Error(`绑定字段不存在：${binding}。请在世界状态修复字段或重新绑定。`);
    const value = state.项目[project][field];
    if (component === 'value' && typeof value === 'number' && Number.isFinite(value)) return value;
    if (['current', 'max'].includes(component) && object(value) && Object.keys(value).length === 2 && Number.isFinite(value.当前) && Number.isFinite(value.最大) && value.最大 > 0 && value.当前 >= 0 && value.当前 <= value.最大) return component === 'current' ? value.当前 : value.最大;
    throw Error(`绑定字段类型不匹配：${binding}。数字使用“数字值”，进度使用“当前值”或“最大值”。`);
}
export function resolveStat(ctx, characterId, statId) {
    const character = getCharacter(ctx, characterId);
    if (!character) throw Error('人物已不存在于当前剧情分支。');
    const stat = character.stats.find(item => item.id === statId);
    if (!stat) throw Error('人物属性已不存在，请重新选择。');
    return { value: boundValue(readWorldStatus(ctx), stat.binding, stat.component), label: stat.label, character, stat };
}
export function bindings(ctx) {
    const raw = ctx?.chatMetadata?.variables?.状态栏;
    if (raw === undefined || raw === null || raw === '') return [];
    const state = readWorldStatus(ctx), result = [];
    for (const [project, fields] of Object.entries(state.项目)) {
        if (!safeName(project) || !object(fields)) continue;
        for (const field of Object.keys(fields)) {
            if (!safeName(field)) continue;
            const binding = `${project}.${field}`;
            for (const [component, suffix] of [['value', '数字值'], ['current', '当前值'], ['max', '最大值']]) {
                try { result.push({ binding, component, label: `${binding} · ${suffix}`, value: boundValue(state, binding, component) }); } catch { /* Non-numeric fields are not selectable. */ }
            }
        }
    }
    return result;
}
export function withStatValue(ctx, characterId, statId, input) {
    if (typeof input !== 'number' || !Number.isFinite(input) || Math.abs(input) > LIMITS.number) throw Error(`属性数值必须为 ±${LIMITS.number} 范围内的有限数字。`);
    const resolved = resolveStat(ctx, characterId, statId), state = readWorldStatus(ctx);
    const [project, field] = bindingParts(resolved.stat.binding);
    if (resolved.stat.component === 'value') state.项目[project][field] = input;
    else {
        const progress = state.项目[project][field];
        progress[resolved.stat.component === 'current' ? '当前' : '最大'] = input;
        if (!(progress.最大 > 0 && progress.当前 >= 0 && progress.当前 <= progress.最大)) throw Error('进度需满足 0 ≤ 当前值 ≤ 最大值，且最大值必须大于 0。');
    }
    return { state, before: resolved.value, after: input, ...resolved, value: input };
}
