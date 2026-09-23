import { KEY, readStore, currentEntries, memoryEntries, sourceFromRange, sourceState, referenceState, changeWithContext, putAutoDraft } from '../../journal/model.js';
import { KEY as CHARACTERS_KEY, readCharacters, validId } from '../../characters/model.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (data, allowed) => {
    if (!plain(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('剧情档案更新包含未知字段');
};
const RANGE = ['sourceStart', 'sourceEnd'];
function source(ctx, data) {
    const start = data.sourceStart ?? ctx.chat.length - 1, end = data.sourceEnd ?? start;
    return sourceFromRange(ctx.chat, start, end);
}
function withoutRange(data) {
    const { sourceStart, sourceEnd, ...rest } = data; return rest;
}
export const adapter = {
    id: 'journal', label: '剧情档案与记忆', paths: [[KEY], [CHARACTERS_KEY]],
    contract: `全部 target 使用稳定档案 ID，创建新记录需显式提供安全 ID（字母、数字、下划线或连字符，最多100字符）。sourceStart/sourceEnd 为从0开始、包含首尾的当前已加载楼层；省略时使用最后一楼。以下 data 未列出的字段不可写；不能修改引用开关、自动整理设置或前作资料。
set_fact: target=事实ID, data={title?:非空文本<=120,body?:非空事实内容<=60000,truth?:confirmed|uncertain|disputed,sourceNote?:文本<=1000,sourceStart?:整数,sourceEnd?:整数}。新建时 title/body 必填；未证实信息用 uncertain，不能把传闻当确认事实。
set_knowledge: target=记忆ID, data={factId?:当前分支已有事实ID,characterId?:当前人物ID,state?:known|rumor|forgotten,belief?:该人物认知或传闻文本<=6000,confidence?:0..100数字,learnedFromId?:现有人物ID或null,learnedAtText?:获知时间<=160,sourceNote?:文本<=1000,sourceStart?:整数,sourceEnd?:整数}。新建时 factId/characterId 必填；同一人物同一事实只允许一条记忆，更新已有ID。未登记知情不代表知道；遗忘不删除事实。
forget: target=已有记忆ID, data={}。保留原获知来源与时间，仅标记遗忘。
set_hook: target=伏笔ID, data={title?:非空文本<=120,body?:非空内容<=60000,status?:open|resolved|abandoned,remindAfter?:1..100000整数或null,actors?:人物名称数组最多32项,sourceNote?:文本<=1000,sourceStart?:整数,sourceEnd?:整数}。新建 title/body 必填。
draft_chronicle: target=新草稿ID, data={title:非空文本<=120,body:非空正文<=60000,sourceStart:整数,sourceEnd:整数}。仅产生可审核草稿，不直接建立已确认编年史。
delete: target=已有事实/记忆/伏笔ID, data={}。保留事件历史；删除事实后关联记忆仍显示缺失引用，不自动删除或改绑。`,
    read(ctx) {
        const chat = ctx?.chat ?? [], entries = currentEntries(readStore(ctx), chat);
        return {
            entries: entries.map(({ savedAt, savedFloor, eventId, sources, ...record }) => ({ ...record,
                sourceRange: sources ? { start: sources.start, end: sources.end } : null,
                sourceValid: record.kind === 'prior' ? record.explicitReference === true : sourceState(sources, chat).valid })),
            memories: memoryEntries(ctx).map(({ id, factId, characterId, characterName, learnedFromId, learnedFromName, state, belief, confidence, learnedAtText, missing }) => ({
                id, factId, characterId, characterName, learnedFromId, learnedFromName, state, belief, confidence, learnedAtText, missing,
            })),
        };
    },
    readForPrompt(ctx) {
        const chat = ctx?.chat ?? [], records = currentEntries(readStore(ctx), chat), facts = new Map(records.filter(record => record.kind === 'fact').map(record => [record.id, record]));
        const people = new Set(readCharacters(ctx).characters.map(person => person.id));
        const enabled = record => record.confirmed === true && record.enabled === true && referenceState(record, chat).valid
            && (record.kind !== 'knowledge' || (people.has(record.characterId) && referenceState(facts.get(record.factId), chat).valid));
        return {
            entries: records.filter(enabled).map(({ savedAt, savedFloor, eventId, sources, origin, ...record }) => ({ ...record,
                ...(origin ? { origin: { work: origin.work, recordId: origin.recordId, kind: origin.kind, sourceNote: origin.sourceNote } } : {}),
                sourceRange: sources ? { start: sources.start, end: sources.end } : null,
            })),
            unavailable: records.filter(record => !enabled(record)).map(record => ({ id: record.id, kind: record.kind, availableForReference: false })),
        };
    },
    apply(ctx, change, { operationId, now } = {}) {
        if (!plain(change) || typeof change.reason !== 'string' || !change.reason.trim() || !validId(change.target)) throw Error('剧情档案更新需要安全的目标编号和变更原因');
        if (typeof operationId !== 'string' || !operationId || (typeof now !== 'string' && !(now instanceof Date))) throw Error('剧情档案联动缺少协调器操作编号或时间');
        const store = readStore(ctx), records = currentEntries(store, ctx.chat), before = records.find(record => record.id === change.target), data = change.data ?? {};
        const at = now instanceof Date ? now.toISOString() : now;
        if (store.events.some(event => event.id === operationId) || (store.draftEvents ?? []).some(event => event.id === operationId)) return { patches: [{ path: [KEY], value: store }], summary: `已处理剧情档案操作：${change.target}` };
        let next, label;
        if (change.action === 'draft_chronicle') {
            fields(data, ['title','body', ...RANGE]);
            if (!Number.isInteger(data.sourceStart) || !Number.isInteger(data.sourceEnd)) throw Error('编年史草稿必须明确来源范围');
            next = putAutoDraft(store, ctx.chat, { id: change.target, title: data.title, body: data.body, sources: source(ctx, data) }, operationId, at); label = '新增待确认编年史草稿';
        } else if (change.action === 'delete') {
            fields(data, []);
            if (!before || !['fact','knowledge','hook'].includes(before.kind)) throw Error('仅可删除当前分支已有的事实、人物记忆或伏笔');
            next = changeWithContext(store, ctx, 'delete', { id: before.id }, operationId, at); label = '删除档案';
        } else if (change.action === 'forget') {
            fields(data, []);
            if (before?.kind !== 'knowledge') throw Error('遗忘操作需要已有的人物记忆');
            next = changeWithContext(store, ctx, 'update', { ...before, state: 'forgotten' }, operationId, at); label = '标记遗忘';
        } else {
            const kind = { set_fact: 'fact', set_knowledge: 'knowledge', set_hook: 'hook' }[change.action];
            if (!kind) throw Error('不支持的剧情档案操作');
            if (before && before.kind !== kind) throw Error('不能变更已有档案的类型');
            const allowed = kind === 'fact' ? ['title','body','truth','sourceNote', ...RANGE]
                : kind === 'knowledge' ? ['factId','characterId','state','belief','confidence','learnedFromId','learnedAtText','sourceNote', ...RANGE]
                    : ['title','body','status','remindAfter','actors','sourceNote', ...RANGE];
            fields(data, allowed);
            const record = { ...(before ?? {}), ...withoutRange(data), id: change.target, kind, sources: source(ctx, data), enabled: before?.enabled ?? false };
            if (kind === 'knowledge') {
                const fact = records.find(item => item.id === record.factId && item.kind === 'fact'), people = new Set(readCharacters(ctx).characters.map(person => person.id));
                if (!fact) throw Error('记忆关联的事实不存在');
                if (!people.has(record.characterId) || (record.learnedFromId && !people.has(record.learnedFromId))) throw Error('记忆关联的人物不存在');
                record.title = fact.title; record.body = '';
            }
            next = changeWithContext(store, ctx, before ? 'update' : 'create', record, operationId, at); label = `${before ? '更新' : '新增'}${kind === 'fact' ? '事实' : kind === 'knowledge' ? '人物记忆' : '伏笔'}`;
        }
        return { patches: [{ path: [KEY], value: next }], summary: `${label}：${change.target} · ${change.reason.trim()}` };
    },
};
