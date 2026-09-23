import { KEY, readCurrentScene, readStore, appendEvent, transition, assertReferences, absencePreview } from '../../scene/model.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = {
    'set-time': ['clock'], 'advance-time': ['minutes'], activity: ['activity', 'count'],
    'save-scene': ['name', 'participants', 'participantIds', 'weather', 'objects', 'notes', 'mapId', 'nodeId', 'activate'],
    'switch-scene': [], 'leave-scene': [], 'confirm-presence': ['characterIds'],
    'save-schedule': ['characterId', 'title', 'startMinute', 'endMinute', 'mapId', 'nodeId', 'weekdays', 'enabled', 'notes'],
    'delete-schedule': [], 'settle-absence': [],
};
const targetActions = new Set(['save-scene', 'switch-scene', 'confirm-presence', 'save-schedule', 'delete-schedule', 'settle-absence']);
export const adapter = {
    id: 'scene', label: '场景、时间与日程', paths: [[KEY], ['amin_os_characters_v1'], ['dynamicMapV1']],
    contract: 'set-time: data={clock:{year,month,day,hour,minute,calendarLabel?,calendar?:{monthLengths,monthNames,weekDays,epochWeekday}}}，校正剧情时钟。advance-time: data={minutes:1..5256000整数}。activity: data={activity:dialogue|shortRest|longRest|travel,count?:1..1000整数}，按用户耗时规则推进；重生成不得重复计时。save-scene: target=当前或新的安全场景ID,data={name?,participants?,participantIds?:现有人物ID数组,weather?,objects?,notes?,mapId?,nodeId?,activate?:boolean}；新场景必填name。switch-scene: target=当前分支场景ID,data={}。leave-scene:data={}。confirm-presence: target=场景ID,data={characterIds:现有人物ID数组}，只记录剧情明确在场的人物。save-schedule:target=当前或新的安全日程ID,data={characterId,title,startMinute:0..1439,endMinute:1..1440,mapId,nodeId,weekdays?:从0开始的星期序号数组,enabled?:boolean,notes?}；结束早于开始表示跨夜，空weekdays表示每日。delete-schedule:target=日程ID,data={}。settle-absence:target=已到期的离场规则ID,data={}，按用户既有规则更新场景字段；不改规则。日程只预测地点，不更新地图、不推翻明确在场。耗时与离场规则及上下文开关由用户配置，不能通过本模块更新。',
    read(ctx) {
        const state = readCurrentScene(ctx);
        // Referenced IDs belong to scene records; labels/content from other modules follow their own read policy.
        return { ...state, pendingAbsence: absencePreview(state) };
    },
    apply(ctx, change, { operationId, now } = {}) {
        if (!Object.hasOwn(fields, change.action)) throw Error('场景不支持此联动操作。');
        if (!object(change.data) || Object.keys(change.data).some(key => !fields[change.action].includes(key))) throw Error('场景联动参数含不支持的字段。');
        if (targetActions.has(change.action) && !safeId(change.target)) throw Error('场景联动目标 ID 无效。');
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('场景变更需要剧情依据。');
        if (!safeId(operationId)) throw Error('场景联动操作编号无效。');
        const state = readCurrentScene(ctx), data = { ...structuredClone(change.data), reason: change.reason }, options = { at: now };
        if (change.action === 'save-scene') {
            if (data.activate !== undefined && typeof data.activate !== 'boolean') throw Error('场景进入开关无效。');
            const { activate, reason, ...scene } = data;
            data.scene = { ...state.scenes[change.target], ...scene, ...(state.scenes[change.target] ? { id: change.target } : {}) };
            data.activate = activate; data.reason = reason; options.sceneId = change.target;
        } else if (['switch-scene', 'confirm-presence'].includes(change.action)) data.sceneId = change.target;
        else if (change.action === 'save-schedule') {
            const existing = state.schedules.find(item => item.id === change.target);
            const { reason, ...schedule } = data;
            data.schedule = { ...existing, ...schedule, ...(existing ? { id: change.target } : {}) }; options.entryId = change.target;
        } else if (change.action === 'delete-schedule') data.id = change.target;
        else if (change.action === 'settle-absence') data.ruleIds = [change.target];
        assertReferences(ctx, change.action, data, state);
        const result = transition(state, change.action, data, options);
        const value = appendEvent(readStore(ctx), ctx.chat, { ...result, op: change.action }, { eventId: operationId, at: now });
        const label = result.details.sceneName || result.details.entry?.title || result.details.changes?.map(item => item.title).join('、') || change.action;
        return { patches: [{ path: [KEY], value }], summary: `场景与时间：${label}；${change.reason}` };
    },
};
