import { sha256HexSync } from '../tts/source-hash.js';

const compactPattern = /^sha256:[0-9a-f]{64}$/u;
const cached = new WeakMap();

const parts = message => [message?.name ?? '', !!message?.is_user, message?.mes ?? '', message?.swipe_id ?? 0];
const validParts = value => Array.isArray(value) && value.length === 4 && typeof value[0] === 'string'
    && typeof value[1] === 'boolean' && typeof value[2] === 'string'
    && Number.isInteger(value[3]) && value[3] >= 0;

function legacyParts(value) {
    if (typeof value !== 'string' || !value.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(value);
        return validParts(parsed) ? parsed : null;
    } catch { return null; }
}

/** The old four-field serialization is retained only as a read format. */
export function validMessageRevision(value) {
    return typeof value === 'string' && (compactPattern.test(value) || !!legacyParts(value));
}

/** SHA-256 of the original name/user/body/swipe tuple, without persisting the body. */
export function messageRevision(message) {
    const value = parts(message);
    if (message !== null && typeof message === 'object') {
        const previous = cached.get(message);
        if (previous && previous.parts.every((part, index) => part === value[index])) return previous.revision;
    }
    const revision = 'sha256:' + sha256HexSync(JSON.stringify(value));
    if (message !== null && typeof message === 'object') cached.set(message, { parts: value, revision });
    return revision;
}

export function chatRevisions(chat = []) {
    if (!Array.isArray(chat)) throw Error('当前聊天记录格式无效。');
    return chat.map(messageRevision);
}

/** A persisted old revision still matches the same current message or new digest. */
export function sameMessageRevision(left, right) {
    if (left === right) return validMessageRevision(left);
    const leftCompact = typeof left === 'string' && compactPattern.test(left);
    const rightCompact = typeof right === 'string' && compactPattern.test(right);
    if (leftCompact === rightCompact) return false;
    const legacy = legacyParts(leftCompact ? right : left);
    return !!legacy && (leftCompact ? left : right) === 'sha256:' + sha256HexSync(JSON.stringify(legacy));
}

export function pathBelongs(anchor, current) {
    return Array.isArray(anchor) && Array.isArray(current) && anchor.length <= current.length
        && anchor.every((part, index) => sameMessageRevision(part, current[index]));
}
