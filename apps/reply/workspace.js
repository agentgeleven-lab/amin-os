// Main and message-floor reply windows share the same candidates/settings UI.
import { mount as mountReply } from './index.js';
const mounted = new WeakMap();
export function mount(target, options = {}) {
    if (mounted.has(target)) return mounted.get(target);
    const hostContext = options.getContext ?? (() => globalThis.SillyTavern?.getContext?.());
    const validate = () => {
        const ctx = hostContext();
        if (options.contextProvider) options.contextProvider(ctx);
    };
    validate();
    const reply = (options.mountReply ?? mountReply)({ target,
        instanceId: options.instanceId, headingText: options.headingText,
        getContext: hostContext, contextProvider: options.contextProvider });
    if (!reply) throw Error('请等待聊天输入框加载完成后重试。');
    let disposed = false;
    const api = {
        open(page = 'candidates') {
            if (disposed) throw Error('窗口已关闭，请重新打开。');
            validate(); reply.open?.(page === 'rewrite' ? 'settings' : page);
        },
        dispose() { if (disposed) return; disposed = true; reply.dispose(); mounted.delete(target); },
    };
    mounted.set(target, api);
    return api;
}
