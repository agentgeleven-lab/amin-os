// A selected chat filename is not proof that its payload has finished loading.
// CHAT_CHANGED is emitted after the host installs metadata and messages.
let installed;
const identity = ctx => JSON.stringify([ctx?.groupId ?? null,
    ctx?.characters?.[ctx?.characterId]?.avatar ?? ctx?.characterId ?? null,
    ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null]);
const valid = ctx => typeof ctx?.chatMetadata?.integrity === 'string' && !!ctx.chatMetadata.integrity && Array.isArray(ctx?.chat)
    && (ctx.getCurrentChatId?.() ?? ctx.chatId) != null
    && (ctx.getCurrentChatId?.() ?? ctx.chatId) !== '';

export function createChatLifecycle(getContext) {
    let accepted = null;
    const initial = getContext(), source = initial?.eventSource;
    const events = initial?.eventTypes ?? initial?.event_types ?? {};
    const event = events.CHAT_CHANGED;
    const loaded = id => {
        const ctx = getContext();
        if (!valid(ctx) || (id != null && String(id) !== String(ctx.getCurrentChatId?.() ?? ctx.chatId))) {
            accepted = null; return;
        }
        accepted = { metadata: ctx.chatMetadata, integrity: ctx.chatMetadata.integrity, identity: identity(ctx), hadMessages: ctx.chat.length > 0 };
    };
    const deleted = () => {
        const ctx = getContext();
        if (accepted && accepted.metadata === ctx?.chatMetadata && accepted.identity === identity(ctx)) accepted.hadMessages = !!ctx.chat?.length;
    };
    if (event) source?.on?.(event, loaded);
    if (events.MESSAGE_DELETED) source?.on?.(events.MESSAGE_DELETED,deleted);
    return {
        ready(ctx = getContext()) {
            const matches = candidate => valid(candidate) && accepted && accepted.metadata === candidate.chatMetadata
                && accepted.integrity === candidate.chatMetadata.integrity && accepted.identity === identity(candidate)
                && !(accepted.hadMessages && !candidate.chat.length);
            if (!matches(getContext())) {
                accepted = null; return false;
            }
            return !!matches(ctx);
        },
        dispose() { if (event) (source?.removeListener ?? source?.off)?.call(source,event,loaded); if(events.MESSAGE_DELETED)(source?.removeListener ?? source?.off)?.call(source,events.MESSAGE_DELETED,deleted); accepted = null; },
    };
}
export function initializeChatLifecycle(getContext) {
    return installed ??= createChatLifecycle(getContext);
}
export const isChatReady = ctx => !installed || installed.ready(ctx);
export function assertChatReady(ctx) {
    if (!isChatReady(ctx)) {
        const error = new Error('聊天正在加载或切换，请等待加载完成后再操作。');
        error.code = 'CHAT_LOADING'; throw error;
    }
}
