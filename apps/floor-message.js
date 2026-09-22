import { uuid } from '../uuid.js';
import { sha256Hex } from './tts/source-hash.js';
// Persistent identity belongs to the message; its text/selected reply determine
// the version. Reordering floors must never attach another message's audio.
export function messageVersion(message) {
    return JSON.stringify([message?.name ?? '', Boolean(message?.is_user), message?.mes ?? '', message?.swipe_id ?? 0]);
}
export function ensureAudioMessageId(message, createId = () => uuid()) {
    message.extra ??= {};
    if (typeof message.extra.amin_os_tts_message_id === 'string' && message.extra.amin_os_tts_message_id) return false;
    message.extra.amin_os_tts_message_id = createId();
    return true;
}
const pendingSaves = new WeakMap();
export async function persistAudioMessageId(ctx, message) {
    if (pendingSaves.has(message)) return pendingSaves.get(message);
    if (message.extra?.amin_os_tts_message_id) return;
    if (typeof ctx.saveChat !== 'function') throw Error('当前宿主缺少楼层保存接口，无法保存音频来源。');
    ensureAudioMessageId(message);
    const id = message.extra.amin_os_tts_message_id;
    const pending = Promise.resolve().then(() => ctx.saveChat()).catch(error => {
        if (message.extra?.amin_os_tts_message_id === id) delete message.extra.amin_os_tts_message_id;
        throw error;
    }).finally(() => pendingSaves.delete(message));
    pendingSaves.set(message, pending);
    return pending;
}
export async function audioMessageSource(chatKey, message, cryptoSource = globalThis.crypto) {
    const id = message?.extra?.amin_os_tts_message_id;
    if (!id) throw Error('无法建立可靠的楼层音频来源，请刷新后重试。');
    const version = await sha256Hex(messageVersion(message), cryptoSource);
    return `amin-tts:${chatKey}:${id}:${version}`;
}
