import { uuid } from '../../uuid.js';
import { KEY as CHARACTERS_KEY, readCharacters } from '../characters/model.js';
import { createOperationService, subscribeStateChanges, chatIdentity } from '../shared/operations.js';
import { KEY, readStore, readRelationships, resolveRelationships, visibleEvents, chatPath, transition, appendSnapshot, currentPrompt } from './model.js';

export const PROMPT_KEY = 'amin-os-person-relationships';
const copy = value => structuredClone(value);
export function createRelationshipsService(getContext = () => globalThis.SillyTavern?.getContext?.(), { createId = uuid, now = () => new Date().toISOString(), poll = false } = {}) {
    const operation = createOperationService(getContext), listeners = new Set(), removers = [];
    let pending = null, disposed = false, last = null, hostMessage = '';
    const notify = () => { for (const callback of [...listeners]) { try { callback(); } catch { /* A view cannot break a committed change. */ } } };
    function clearPrompt() { try { getContext()?.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false); } catch { /* Host may be switching chats. */ } }
    function ensureOpen() { if (disposed) throw Error('人物关系服务已关闭。'); }
    const capture = () => { ensureOpen(); return operation.capture([[KEY], [CHARACTERS_KEY]]); };
    const check = token => { ensureOpen(); return operation.check(token); };
    function stage(op, data, token = capture()) {
        const ctx = check(token), before = readRelationships(ctx);
        const relationshipId = op === 'save' ? data?.relationship?.id ?? createId() : undefined;
        const state = transition(before, op, copy(data), { relationshipId });
        let relationship;
        if (op === 'save') {
            relationship = state.relationships.find(value => value.id === relationshipId);
            const previous = before.relationships.find(value => value.id === relationshipId);
            const characters = new Set(readCharacters(ctx).characters.map(character => character.id));
            for (const key of ['fromId', 'toId']) if (previous?.[key] !== relationship[key] && !characters.has(relationship[key])) throw Error('新增或更换的关系端点必须选择当前人物；请先在角色卡中建立人物。');
        }
        const names = new Map(readCharacters(ctx).characters.map(character => [character.id, character.name]));
        const named = id => names.get(id) ?? `未解析人物（${id}）`;
        const label = op === 'save' ? before.relationships.some(value => value.id === relationshipId) ? '修改人物关系' : '新建人物关系'
            : op === 'delete' ? '删除人物关系' : '设置人物关系读取';
        const removed = op === 'delete' ? before.relationships.find(value => value.id === data.id) : null;
        const described = relationship ?? removed;
        const summary = described ? `${named(described.fromId)} → ${named(described.toId)} · ${described.type}${described.label ? ` · ${described.label}` : ''}${Object.hasOwn(described, 'strength') ? ` · 强度 ${described.strength}` : ''}`
            : state.settings.includeInContext ? '普通正文生成时读取当前分支中人物引用完整的已确认关系。' : '关闭人物关系的正文读取。';
        const value = appendSnapshot(readStore(ctx), ctx.chat, state, { id: createId(), at: now(), op });
        operation.stage({ label, patches: [{ path: [KEY], value }], summary }, token);
        pending = { op, ...(relationship ? { relationship } : {}), ...(removed ? { id: removed.id } : {}), ...(op === 'settings' ? { includeInContext: state.settings.includeInContext } : {}) };
        hostMessage = ''; notify(); return preview();
    }
    function preview() {
        const value = operation.preview();
        if (!value) return null;
        return { operationId: value.operationId, label: value.label, summary: value.summary, ...copy(pending ?? {}) };
    }
    function scope() {
        const ctx = getContext();
        return { metadata: ctx?.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx?.chat)),
            basis: JSON.stringify([ctx?.chatMetadata?.[KEY], ctx?.chatMetadata?.[CHARACTERS_KEY]]) };
    }
    function sync() {
        if (disposed) return;
        let next;
        try { next = scope(); } catch (error) { hostMessage = error.message; clearPrompt(); notify(); return; }
        const changed = !last || next.metadata !== last.metadata || next.identity !== last.identity || next.path !== last.path || next.basis !== last.basis;
        if (!changed) return;
        last = next; clearPrompt(); pending = null;
        if (operation.preview()) operation.discard();
        notify();
    }
    async function confirm() { ensureOpen(); const result = await operation.confirm(); pending = null; sync(); return result; }
    async function retrySave() { ensureOpen(); const result = await operation.retrySave(); sync(); return result; }
    function start(type = 'normal', options = {}, dryRun = false) {
        clearPrompt();
        if (disposed || dryRun || options?.signal?.aborted || !['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
        try {
            if (operation.busy()) throw Error('当前聊天正在保存，本轮未附加人物关系。');
            const ctx = getContext();
            if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) return;
            let chat = ctx.chat ?? [];
            if (['regenerate', 'swipe'].includes(type) && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
            const prompt = currentPrompt({ ...ctx, chat });
            ctx.setExtensionPrompt?.(PROMPT_KEY, prompt, 1, 0, false);
            hostMessage = prompt ? `已附加 ${prompt.length} 字符已确认人物关系。` : '当前分支未开启人物关系读取，或暂无人物引用完整的关系。';
        } catch (error) { hostMessage = error.message; }
        notify();
    }
    removers.push(operation.subscribe(() => { hostMessage = ''; notify(); }));
    removers.push(subscribeStateChanges(detail => { if (detail.paths.some(path => path[0] === KEY || path[0] === CHARACTERS_KEY)) sync(); }));
    const initial = getContext(), source = initial?.eventSource, types = initial?.eventTypes ?? initial?.event_types ?? {};
    const supported = !!(initial?.setExtensionPrompt && source?.on && types.GENERATION_AFTER_COMMANDS && types.CHAT_CHANGED);
    const clearAndSync = () => { clearPrompt(); sync(); };
    const handlers = Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map(name => [name, clearAndSync]));
    if (supported) handlers.GENERATION_AFTER_COMMANDS = start;
    for (const [name, callback] of Object.entries(handlers)) if (source?.on && types[name]) {
        source.on(types[name], callback); removers.push(() => source.removeListener ? source.removeListener(types[name], callback) : source.off?.(types[name], callback));
    }
    const timer = poll ? setInterval(sync, 800) : null;
    sync();
    return { context: getContext, capture, check, stage, preview, confirm, retrySave, sync, supported,
        read: () => readRelationships(getContext()), characters: () => readCharacters(getContext()).characters, resolved: () => resolveRelationships(getContext()), history: () => visibleEvents(getContext()),
        saveRelationship: (relationship, token) => stage('save', { relationship }, token), deleteRelationship: (id, token) => stage('delete', { id }, token),
        discard() { pending = null; hostMessage = ''; operation.discard(); },
        status: () => hostMessage || operation.status(), busy: () => operation.busy(), dirty: () => operation.dirty(),
        subscribe(callback) { ensureOpen(); listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; pending = null; clearPrompt(); clearInterval(timer); for (const remove of removers) remove(); operation.dispose(); listeners.clear(); },
    };
}
let shared;
export function getSharedRelationshipsService(getContext) { return shared ??= createRelationshipsService(getContext, { poll: true }); }
