// Share one host-chat scan across floor applications. App-owned windows never
// schedule another scan merely because their contents have rendered.
const documents = new WeakMap();
const EVENTS = ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED'];
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
const owned = node => Boolean(elementOf(node)?.closest?.('.amin-floor'));
const inChat = node => Boolean(elementOf(node)?.closest?.('#chat'));
const containsChat = node => node?.nodeType === 1 && (node.id === 'chat' || Boolean(node.querySelector?.('#chat')));

function relevant(record) {
    if (owned(record.target)) return false;
    if (record.type === 'attributes') return inChat(record.target);
    const changed = [...record.addedNodes, ...record.removedNodes];
    if (changed.length && changed.every(owned)) return false;
    return inChat(record.target) || changed.some(containsChat);
}

function createScheduler(document, getContext) {
    const view = document.defaultView ?? globalThis;
    const requestFrame = view.requestAnimationFrame?.bind(view) ?? (fn => setTimeout(fn, 16));
    const cancelFrame = view.cancelAnimationFrame?.bind(view) ?? clearTimeout;
    const subscribers = new Set();
    let frame = null, disposed = false;
    let floors = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    function deliver(subscriber) {
        try { subscriber.listener(floors); }
        catch (error) { console.error('[Amin os] Floor refresh failed:', error); }
    }
    function refresh() {
        if (disposed || frame !== null) return;
        frame = requestFrame(() => {
            frame = null;
            if (disposed) return;
            floors = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
            for (const subscriber of [...subscribers]) if (subscribers.has(subscriber)) deliver(subscriber);
        });
    }
    const Observer = view.MutationObserver ?? globalThis.MutationObserver;
    const observer = Observer ? new Observer(records => { if (records.some(relevant)) refresh(); }) : null;
    // Watching the body also catches a replaced #chat container and chats that
    // were not mounted when the first application subscribed.
    const root = document.body ?? document.documentElement;
    if (root) observer?.observe(root, {childList:true, subtree:true, attributes:true, attributeFilter:['mesid']});
    const context = getContext(), source = context?.eventSource, events = context?.eventTypes ?? context?.event_types ?? {};
    const names = [...new Set(EVENTS.map(name => events[name]).filter(Boolean))];
    if (source?.on) for (const name of names) source.on(name, refresh);
    return {
        subscribe(listener) {
            const subscriber = {listener};
            subscribers.add(subscriber);
            deliver(subscriber);
            return {
                refresh() { if (subscribers.has(subscriber)) refresh(); },
                dispose() {
                    if (!subscribers.delete(subscriber) || subscribers.size) return;
                    disposed = true;
                    if (frame !== null) cancelFrame(frame);
                    observer?.disconnect();
                    for (const name of names) {
                        if (source?.removeListener) source.removeListener(name, refresh);
                        else source?.off?.(name, refresh);
                    }
                    documents.delete(document);
                },
            };
        },
    };
}

export function observeChatFloors(listener, {document = globalThis.document, getContext = () => globalThis.SillyTavern?.getContext?.()} = {}) {
    let scheduler = documents.get(document);
    if (!scheduler) { scheduler = createScheduler(document, getContext); documents.set(document, scheduler); }
    return scheduler.subscribe(listener);
}
