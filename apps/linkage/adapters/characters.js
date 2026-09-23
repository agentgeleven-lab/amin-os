import { KEY, STATUS_PATH, readCharacters, readStore, appendSnapshot, validateCharacter, validateStat, validateAppearance, validId, bindings } from '../../characters/model.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(data, allowed) {
    if (!object(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('人物联动参数包含不支持的字段。');
}
function stats(input) {
    if (!Array.isArray(input)) throw Error('人物绑定必须是数组。');
    return input.map(stat => { fields(stat, ['id', 'label', 'binding', 'component', 'check']); return validateStat(stat); });
}
function checkBindings(ctx, previous, next) {
    const changed = next.stats.filter(stat => !previous?.stats.some(old => old.id === stat.id && old.binding === stat.binding && old.component === stat.component));
    if (!changed.length) return;
    const available = bindings(ctx);
    for (const stat of changed) if (!available.some(field => field.binding === stat.binding && field.component === stat.component)) throw Error(`人物绑定不存在或类型不匹配：${stat.binding}。请先建立世界状态字段。`);
}

export const adapter = {
    id: 'characters', label: '人物卡与外观',
    paths: [[KEY], [...STATUS_PATH]],
    contract: 'target=稳定人物ID。create-character: data={name,kind:"pc"|"npc",notes?,stats?:[{id,label,binding:"项目名.字段名",component:"value"|"current"|"max",check:"none"|"d20"|"coc"}],appearance?:{description,hairstyle,features}}；save-character: 同上字段按需更新现有人物；delete-character: data={}，保留其他应用的原ID引用；save-stat: data={id,label,binding,component,check}；delete-stat: data={statId}；set-appearance: data={description?,hairstyle?,features?}。新增ID须为1–100位字母数字下划线连字符。属性只存世界状态绑定，数值由worldstatus模块更新；穿戴引用inventory的ownerId+equipped，不得复制衣物记录或更新骰点。',
    read: ctx => readCharacters(ctx),
    apply(ctx, change, { operationId, now }) {
        const state = readCharacters(ctx), previous = state.characters.find(person => person.id === change.target), data = change.data;
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('人物更新需要剧情原因。');
        if (change.action !== 'create-character' && !previous) throw Error('人物已不存在于当前剧情分支。');
        let next = previous;
        if (['create-character', 'save-character'].includes(change.action)) {
            fields(data, ['name', 'kind', 'notes', 'stats', 'appearance']);
            if (change.action === 'create-character' && (!validId(change.target) || previous)) throw Error('新增人物编号无效或已存在。');
            next = validateCharacter({ ...(previous ?? { kind: 'npc', notes: '', stats: [] }), ...data, id: change.target, ...(data.stats === undefined ? {} : { stats: stats(data.stats) }) });
            checkBindings(ctx, previous, next);
        } else if (change.action === 'delete-character') {
            fields(data, []); state.characters = state.characters.filter(person => person.id !== change.target); next = null;
        } else if (change.action === 'set-appearance') {
            fields(data, ['description', 'hairstyle', 'features']);
            next = validateCharacter({ ...previous, appearance: validateAppearance({ ...previous.appearance, ...data }) });
        } else if (change.action === 'save-stat') {
            fields(data, ['id', 'label', 'binding', 'component', 'check']);
            const stat = validateStat(data), index = previous.stats.findIndex(value => value.id === stat.id);
            next = structuredClone(previous);
            if (index < 0) next.stats.push(stat); else next.stats[index] = stat;
            next = validateCharacter(next); checkBindings(ctx, previous, next);
        } else if (change.action === 'delete-stat') {
            fields(data, ['statId']);
            if (!previous.stats.some(stat => stat.id === data.statId)) throw Error('人物属性绑定已不存在。');
            next = validateCharacter({ ...previous, stats: previous.stats.filter(stat => stat.id !== data.statId) });
        } else throw Error('不支持的人物联动操作。');
        if (next) {
            const index = state.characters.findIndex(person => person.id === next.id);
            if (index < 0) state.characters.push(next); else state.characters[index] = next;
        }
        const summary = `${change.action === 'delete-character' ? '移除' : '更新'}人物「${next?.name ?? previous.name}」`;
        return { patches: [{ path: [KEY], value: appendSnapshot(readStore(ctx), ctx.chat, state, { id: operationId, at: now, reason: change.reason }) }], summary };
    },
};
