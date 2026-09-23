import { uuid } from '../../uuid.js';
import { readCharacters } from '../characters/model.js';

export const KEY = 'amin_os_relationships_v1';
export const LIMITS = Object.freeze({ relationships: 500, events: 1000, text: 4000, prompt: 12000, storeChars: 20000000 });
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !unsafe.has(value);
function keys(value, allowed, label) {
    if (!object(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || unsafe.has(key) || !allowed.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)))) throw Error(`${label}格式不兼容，原记录未改写。`);
}
function array(value, limit, label) {
    if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length) throw Error(`${label}格式或数量不兼容。`);
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index) || !('value' in Object.getOwnPropertyDescriptor(value, String(index)))) throw Error(`${label}不能包含空项或访问器。`);
}
function text(value, label, max, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error(`${label}需为${required ? '非空的 ' : ' '} ${max} 字以内文本。`);
    return value.trim();
}
const checkedId = (value, label) => { if (!validId(value)) throw Error(`${label}无效。`); return value; };
export const emptyState = () => ({ version: 1, relationships: [], settings: { includeInContext: false } });
export const emptyStore = () => ({ version: 1, events: [] });

// Exact content/candidate evidence: copied metadata cannot expose another branch's facts.
export const chatPath = chat => {
    if (!Array.isArray(chat ?? [])) throw Error('聊天消息格式不兼容。');
    return (chat ?? []).map(message => {
        if (!object(message)) throw Error('聊天消息格式不兼容。');
        return JSON.stringify([message.name ?? '', !!message.is_user, message.mes ?? '', message.swipe_id ?? 0]);
    });
};
export const belongs = (event, path) => Array.isArray(event?.path) && event.path.length <= path.length && event.path.every((part, index) => part === path[index]);

export function validateRelationship(input) {
    keys(input, ['id', 'fromId', 'toId', 'type', 'label', 'notes', 'strength'], '人物关系');
    const value = {
        id: checkedId(input.id, '关系编号'), fromId: checkedId(input.fromId, '起点人物编号'), toId: checkedId(input.toId, '终点人物编号'),
        type: text(input.type, '关系类型', 60, true), label: text(input.label ?? '', '关系名称', 120), notes: text(input.notes ?? '', '关系说明', LIMITS.text),
    };
    if (value.fromId === value.toId) throw Error('关系的起点和终点需为不同人物。');
    if (Object.hasOwn(input, 'strength')) {
        if (typeof input.strength !== 'number' || !Number.isFinite(input.strength) || Math.abs(input.strength) > 1000000000) throw Error('关系强度需为 -1000000000 至 1000000000 的有限数字；未填写时不记录强度。');
        value.strength = input.strength;
    }
    return value;
}
export function validateState(input) {
    keys(input, ['version', 'relationships', 'settings'], '人物关系快照');
    if (input.version !== 1) throw Error('人物关系快照版本不兼容，原记录未改写。');
    array(input.relationships, LIMITS.relationships, `人物关系（最多 ${LIMITS.relationships} 条）`);
    keys(input.settings, ['includeInContext'], '人物关系设置');
    if (typeof input.settings.includeInContext !== 'boolean') throw Error('人物关系读取设置无效。');
    const relationships = input.relationships.map(validateRelationship);
    if (new Set(relationships.map(value => value.id)).size !== relationships.length) throw Error('人物关系编号重复。');
    const signatures = relationships.map(value => JSON.stringify([value.fromId, value.toId, value.type, value.label]));
    if (new Set(signatures).size !== signatures.length) throw Error('同方向、类型和名称的人物关系已存在，请编辑原关系。');
    return { version: 1, relationships, settings: { includeInContext: input.settings.includeInContext } };
}
export function validateStore(input) {
    keys(input, ['version', 'events'], '人物关系记录');
    if (input.version !== 1) throw Error('人物关系记录版本不兼容，原记录未改写。');
    array(input.events, LIMITS.events, '人物关系事件');
    const ids = new Set();
    const events = input.events.map(event => {
        keys(event, ['id', 'at', 'path', 'op', 'snapshot'], '人物关系事件');
        checkedId(event.id, '关系事件编号');
        if (ids.has(event.id)) throw Error('人物关系事件编号重复。');
        ids.add(event.id);
        if (typeof event.at !== 'string' || event.at.length > 100 || !Number.isFinite(Date.parse(event.at))) throw Error('人物关系记录时间无效。');
        if (!['save', 'delete', 'settings', 'restore'].includes(event.op)) throw Error('人物关系事件操作不兼容。');
        array(event.path, 100000, '人物关系分支记录');
        if (event.path.some(value => typeof value !== 'string')) throw Error('人物关系分支记录格式不兼容。');
        return { id: event.id, at: event.at, path: [...event.path], op: event.op, snapshot: validateState(event.snapshot) };
    });
    const result = { version: 1, events };
    if (JSON.stringify(result).length > LIMITS.storeChars) throw Error('人物关系记录已超过容量限制，请先导出存档保留记录。');
    return result;
}
export function readStore(ctx) { return ctx?.chatMetadata?.[KEY] === undefined ? emptyStore() : validateStore(ctx.chatMetadata[KEY]); }
export function currentState(store, chat) {
    const value = validateStore(store), path = chatPath(chat);
    for (let index = value.events.length - 1; index >= 0; index--) if (belongs(value.events[index], path)) return clone(value.events[index].snapshot);
    return emptyState();
}
export const readRelationships = ctx => currentState(readStore(ctx), ctx?.chat);
export function visibleEvents(ctx) { const path = chatPath(ctx?.chat); return readStore(ctx).events.filter(event => belongs(event, path)); }

export function transition(input, op, data, { relationshipId } = {}) {
    const state = validateState(input);
    if (op === 'save') {
        keys(data?.relationship, ['id', 'fromId', 'toId', 'type', 'label', 'notes', 'strength'], '人物关系');
        const relationship = validateRelationship({ ...data.relationship, id: data.relationship.id ?? relationshipId ?? uuid() });
        const index = state.relationships.findIndex(value => value.id === relationship.id);
        if (index < 0) state.relationships.push(relationship); else state.relationships[index] = relationship;
    } else if (op === 'delete') {
        checkedId(data?.id, '关系编号');
        if (!state.relationships.some(value => value.id === data.id)) throw Error('该人物关系已不存在，请刷新列表。');
        state.relationships = state.relationships.filter(value => value.id !== data.id);
    } else if (op === 'settings') {
        if (typeof data?.includeInContext !== 'boolean') throw Error('请选择是否读取人物关系。');
        state.settings.includeInContext = data.includeInContext;
    } else throw Error('不支持的人物关系操作。');
    return validateState(state);
}
// Save restoration materializes a snapshot at the current tail; it does not replace messages.
export function appendSnapshot(store, chat, state, { id = uuid(), at = new Date().toISOString(), op = 'restore' } = {}) {
    const value = validateStore(store);
    value.events.push({ id, at, op, path: chatPath(chat), snapshot: validateState(state) });
    return validateStore(value);
}
export const buildRestore = (ctx, state, options = {}) => appendSnapshot(readStore(ctx), ctx?.chat, state, { ...options, op: 'restore' });
export function resolveRelationships(ctx) {
    const state = readRelationships(ctx), characters = readCharacters(ctx).characters;
    const lookup = new Map(characters.map(character => [character.id, character]));
    const resolve = id => ({ id, name: lookup.get(id)?.name ?? `未解析人物（${id}）`, missing: !lookup.has(id) });
    return state.relationships.map(relationship => ({ ...relationship, from: resolve(relationship.fromId), to: resolve(relationship.toId) }));
}
export function currentPrompt(ctx) {
    if (!readRelationships(ctx).settings.includeInContext) return '';
    const resolved = resolveRelationships(ctx).filter(relationship => !relationship.from.missing && !relationship.to.missing);
    if (!resolved.length) return '';
    // JSON strings keep free-form user text visibly separate from structural labels.
    const lines = resolved.map(value => JSON.stringify({ from: value.from.name, fromId: value.fromId, to: value.to.name, toId: value.toId, type: value.type,
        ...(value.label ? { label: value.label } : {}), ...(Object.hasOwn(value, 'strength') ? { strength: value.strength } : {}), ...(value.notes ? { notes: value.notes } : {}) }));
    const prompt = `[已确认的人物关系，仅适用于当前剧情分支]\n关系具有方向性；未记录的反向关系和强度均未知。数字强度沿用用户记录，不推导统一量表。\n${lines.join('\n')}\n[/已确认的人物关系]`;
    if (prompt.length > LIMITS.prompt) throw Error(`人物关系提示超过 ${LIMITS.prompt} 字符，本轮未附加；请缩短关系说明或关闭读取。`);
    return prompt;
}
