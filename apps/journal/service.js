import { uuid } from '../../uuid.js';
import { KEY, readStore, path, compile, sourceFromRange } from './model.js';
import { draftChronicle } from './draft.js';
import { getAI } from '../../ai/service.js';
import { acquireMetadataWrite, chatIdentity, subscribeStateChanges } from '../shared/operations.js';

export const PROMPT_KEY = 'amin-os-journal';

export function createJournal(getContext, { ai = getAI } = {}) {
    const listeners = new Set(), pending = new Set(), saved = new WeakMap();
    let busy = false, disposed = false, epoch = 0, message = '引用默认关闭；只有已保存且明确启用的条目会附加到后续生成。';
    const identity = ctx => JSON.stringify([ctx?.groupId ?? null, ctx?.characterId ?? null, ctx?.getCurrentChatId?.() ?? null]);
    const stamp = ctx => JSON.stringify(readStore(ctx));
    const notify = event => { for (const callback of listeners) { try { callback(event); } catch { /* A view must not interrupt persistence. */ } } };
    const clear = () => getContext()?.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false);

    function capture() {
        const ctx = getContext();
        if (disposed) throw Error('剧情档案已关闭');
        if (!ctx?.chatMetadata || ctx.getCurrentChatId?.() == null) throw Error('请先打开一个聊天');
        return { metadata: ctx.chatMetadata, identity: identity(ctx), path: JSON.stringify(path(ctx.chat)), baseline: stamp(ctx), epoch, operationId: uuid() };
    }

    function check(token) {
        const ctx = getContext();
        if (disposed || !token || token.metadata !== ctx?.chatMetadata || token.identity !== identity(ctx) || token.epoch !== epoch) throw Error('聊天已切换或来源已变化，请重新打开编辑器');
        if (token.path !== JSON.stringify(path(ctx.chat))) throw Error('楼层或回复内容已变化，请重新打开编辑器');
        if (token.baseline !== stamp(ctx)) throw Error('剧情档案已被其他窗口修改，请重新打开编辑器');
        return ctx;
    }

    async function save(token, update) {
        if (saved.has(token)) { const previous = saved.get(token); check(previous.token); return structuredClone(previous.value); }
        if (busy) throw Error('正在保存剧情档案，请稍候');
        const ctx = check(token);
        if (typeof ctx.saveMetadata !== 'function') throw Error('当前前端缺少聊天保存接口');
        const release = acquireMetadataWrite(getContext), metadata = ctx.chatMetadata, before = metadata[KEY];
        let next, persisted = false, failed = false;
        busy = true;
        try {
            next = update(readStore(ctx), ctx);
            if (!next || next.version !== 1 || !Array.isArray(next.events)) throw Error('待保存档案格式无效');
            const after = { ...token, baseline: JSON.stringify(next) };
            metadata[KEY] = next;
            await ctx.saveMetadata();
            persisted = true;
            check(after);
            saved.set(token, { value: structuredClone(next), token: after });
            clear(); message = '剧情档案已保存到当前聊天。';
            return structuredClone(next);
        } catch (error) {
            failed = true;
            if (!persisted && next !== undefined && metadata[KEY] === next) {
                if (before === undefined) delete metadata[KEY]; else metadata[KEY] = before;
            }
            message = persisted ? '档案已保存到原聊天，但聊天或来源已变化，请重新打开档案。' : '保存失败：' + error.message;
            throw error;
        } finally { release(); busy = false; notify({ type: 'save', error: failed }); }
    }

    async function generateDraft(token, fields, { signal, check: checkForm = () => {} } = {}) {
        const ctx = check(token), controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.add(controller);
        const frozenFields = structuredClone(fields);
        const guard = () => { check(token); checkForm(); };
        try {
            return await draftChronicle({ ai: ai(), ctx, ...frozenFields,
                sources: sourceFromRange(ctx.chat, frozenFields.start, frozenFields.end), signal: controller.signal, check: guard });
        } finally { pending.delete(controller); signal?.removeEventListener('abort', onAbort); }
    }

    function start(type = 'normal', options = {}, dryRun = false) {
        clear();
        if (disposed || dryRun || !['normal', 'regenerate', 'swipe', 'continue'].includes(type) || options?.signal?.aborted) return;
        try {
            if (busy) throw Error('剧情档案正在保存，本轮未附加引用');
            const ctx = getContext(); let chat = ctx.chat ?? [];
            if (['regenerate', 'swipe'].includes(type) && chat.length && !chat.at(-1).is_user) chat = chat.slice(0, -1);
            const prompt = compile(readStore(ctx), chat);
            ctx.setExtensionPrompt(PROMPT_KEY, prompt, 1, 0, false);
            message = prompt ? `已附加 ${prompt.length} 字符剧情档案引用` : '当前分支没有启用引用的有效条目';
        } catch (error) { message = error.message; }
        notify({ type: 'prompt' });
    }

    function invalidate(type) {
        epoch++;
        for (const controller of pending) controller.abort(new Error('聊天或来源已变化'));
        clear(); message = type === 'chat' ? '已切换聊天，未保存的档案编辑已关闭。' : '楼层或来源已变化，请重新核对档案来源。';
        notify({ type });
    }

    const initial = getContext(), events = initial?.eventTypes ?? initial?.event_types ?? {}, source = initial?.eventSource;
    const supported = !!(initial?.setExtensionPrompt && source?.on && events.GENERATION_AFTER_COMMANDS && events.CHAT_CHANGED);
    const handlers = { GENERATION_AFTER_COMMANDS: start, CHAT_CHANGED: () => invalidate('chat'), GENERATION_ENDED: clear, GENERATION_STOPPED: clear,
        MESSAGE_DELETED: () => invalidate('source'), MESSAGE_SWIPED: () => invalidate('source'), MESSAGE_UPDATED: () => invalidate('source') };
    if (source?.on) for (const [event, callback] of Object.entries(handlers)) if (events[event] && (event !== 'GENERATION_AFTER_COMMANDS' || supported)) source.on(events[event], callback);
    const unsubscribeState = subscribeStateChanges((detail, metadata) => {
        const ctx = getContext();
        if (disposed || detail?.phase !== 'applied' || detail.identity !== chatIdentity(ctx) || (metadata && metadata !== ctx?.chatMetadata) || !detail.paths?.some(path => path[0] === KEY)) return;
        // Same-content restores also invalidate earlier drafts and cached operation tokens.
        invalidate('source');
    });

    return { capture, check, save, generateDraft, supported, context: getContext, read: () => readStore(getContext()), status: () => message, busy: () => busy,
        subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
        dispose() { if (disposed) return; disposed = true; epoch++; for (const controller of pending) controller.abort(); pending.clear(); clear();
            unsubscribeState();
            for (const [event, callback] of Object.entries(handlers)) if (events[event]) (source?.removeListener ?? source?.off)?.call(source, events[event], callback);
            listeners.clear();
        },
    };
}

let shared;
export const getSharedService = () => shared ??= createJournal(() => globalThis.SillyTavern?.getContext?.());
