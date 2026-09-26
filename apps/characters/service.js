import { chatRevision } from '../shared/chat-revision.js';
import { uuid } from '../../uuid.js';
import { createOperationService, subscribeStateChanges } from '../shared/operations.js';
import { KEY, STATUS_PATH, readStore, readCharacters, resolveStat, bindings, validateCharacter, appendSnapshot, withStatValue } from './model.js';
import { KEY as INVENTORY_KEY } from '../inventory/model.js';
import { readCharacterAppearance } from './appearance.js';
import { readCharacterOverview } from './overview.js';
import { KEY as RELATIONSHIPS_KEY } from '../relationships/model.js';
import { KEY as JOURNAL_KEY } from '../journal/model.js';
import { KEY as SCENE_KEY } from '../scene/model.js';

const relevantPaths = [[KEY], [...STATUS_PATH]];
const overviewKeys = [RELATIONSHIPS_KEY, JOURNAL_KEY, SCENE_KEY];
export function createCharactersService(getContext = () => globalThis.SillyTavern?.getContext?.(), { createId = uuid, now = () => new Date().toISOString(), poll = false } = {}) {
    const operations = createOperationService(getContext), listeners = new Set(), removers = [];
    let disposed = false, lastScope = '', lastMetadata = null, lastOverview = [];
    const notify = () => { for (const callback of listeners) { try { callback(); } catch { /* One window must not interrupt another. */ } } };
    const capture = () => operations.capture(relevantPaths);
    const check = token => operations.check(token);
    function sync(forceOverview = false) {
        if (disposed) return;
        const ctx = getContext();
        const next = JSON.stringify([ctx?.getCurrentChatId?.() ?? ctx?.chatId, ctx?.characterId, ctx?.groupId, chatRevision(ctx?.chat), ctx?.chatMetadata?.[KEY], ctx?.chatMetadata?.[INVENTORY_KEY], ctx?.chatMetadata?.variables?.状态栏]);
        // Canonical writes replace roots; length/tail also detect append-only host writers.
        // Never traverse or stringify journal/scene/relationship histories on idle polls.
        const overview = overviewKeys.flatMap(key => {
            const root = ctx?.chatMetadata?.[key], events = root?.events, tail = events?.[events.length - 1];
            return [root, events, events?.length, tail, tail?.id, tail?.at];
        });
        const overviewChanged = overview.some((value, index) => value !== lastOverview[index]);
        if (forceOverview === true || overviewChanged || next !== lastScope || ctx?.chatMetadata !== lastMetadata) {
            lastScope = next; lastMetadata = ctx?.chatMetadata; lastOverview = overview; notify();
        }
    }
    function stageCharacter(input, token = capture()) {
        const ctx = check(token), state = readCharacters(ctx);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('人物资料格式无效。');
        const previous = state.characters.find(item => item.id === input.id);
        const character = validateCharacter({ ...previous, ...input, id: input.id || createId(), kind: input.kind ?? previous?.kind ?? 'pc', notes: input.notes ?? previous?.notes ?? '', stats: (input.stats ?? previous?.stats ?? []).map(stat => ({ ...previous?.stats.find(item => item.id === stat.id), ...stat, id: stat.id || createId(), check: stat.check ?? 'none' })) });
        const index = state.characters.findIndex(item => item.id === character.id);
        if (index === -1) state.characters.push(character); else state.characters[index] = character;
        const value = appendSnapshot(readStore(ctx), ctx.chat, state, { id: createId(), at: now(), reason: index === -1 ? '新建人物' : '编辑人物' });
        operations.stage({ label: index === -1 ? '新建人物' : '保存人物', patches: [{ path: [KEY], value }], summary: `${character.name} · ${character.kind.toUpperCase()} · ${character.stats.length} 项绑定属性；数值继续读取世界状态。` }, token);
        return operations.preview();
    }
    async function saveCharacter(input, token = capture()) { stageCharacter(input, token); await operations.confirm(); return readCharacters(getContext()); }
    function stageDeleteCharacter(id, token = capture()) {
        const ctx = check(token), state = readCharacters(ctx), character = state.characters.find(item => item.id === id);
        if (!character) throw Error('人物已不存在于当前剧情分支。');
        state.characters = state.characters.filter(item => item.id !== id);
        const value = appendSnapshot(readStore(ctx), ctx.chat, state, { id: createId(), at: now(), reason: '删除人物' });
        operations.stage({ label: '删除人物', patches: [{ path: [KEY], value }], summary: `删除 ${character.name}；世界状态字段、物品与关系记录保留，它们的引用可能需要重新选择人物。` }, token);
        return operations.preview();
    }
    async function deleteCharacter(id, token = capture()) { stageDeleteCharacter(id, token); await operations.confirm(); return readCharacters(getContext()); }
    function stageStatValue(characterId, statId, value, token = capture()) {
        const ctx = check(token), change = withStatValue(ctx, characterId, statId, value);
        operations.stage({ label: '修改人物数值', patches: [{ path: [...STATUS_PATH], value: JSON.stringify(change.state) }], summary: `${change.character.name} / ${change.label}：${change.before} → ${change.after}；同步修改世界状态 ${change.stat.binding}。` }, token);
        return operations.preview();
    }
    async function setStatValue(characterId, statId, value, token = capture()) { stageStatValue(characterId, statId, value, token); await operations.confirm(); return resolveStat(getContext(), characterId, statId); }
    removers.push(operations.subscribe(notify), subscribeStateChanges((detail, metadata) => {
        const relevant = metadata === getContext()?.chatMetadata && detail.paths?.some(path => overviewKeys.includes(path[0]));
        sync(relevant);
    }));
    const ctx = getContext(), source = ctx?.eventSource, types = ctx?.eventTypes ?? ctx?.event_types ?? {};
    for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) if (types[name] && source?.on) {
        const refresh = () => sync(true);
        source.on(types[name], refresh); removers.push(() => source.removeListener ? source.removeListener(types[name], refresh) : source.off?.(types[name], refresh));
    }
    const timer = poll ? setInterval(sync, 800) : null;
    sync();
    return { context: getContext, capture, check, read: () => readCharacters(getContext()), bindings: () => bindings(getContext()), resolveStat: (characterId, statId) => resolveStat(getContext(), characterId, statId), appearance: characterId => readCharacterAppearance(getContext(), characterId),
        overview: characterId => readCharacterOverview(getContext(), characterId),
        stageCharacter, saveCharacter, stageDeleteCharacter, deleteCharacter, stageStatValue, setStatValue, sync,
        preview: operations.preview, confirm: operations.confirm, retrySave: operations.retrySave, discard: operations.discard, status: operations.status, busy: operations.busy, dirty: operations.dirty,
        subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; clearInterval(timer); for (const remove of removers) remove(); operations.dispose(); listeners.clear(); },
    };
}
let shared;
export function getSharedCharactersService(getContext) { return shared ??= createCharactersService(getContext, { poll: true }); }
