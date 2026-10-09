import { sha256HexSync } from '../tts/source-hash.js';
import { STORY_MESSAGE_ID, STORY_CANDIDATE_ID, selectedCandidate, validateIndex } from './story-chat-index.js';

const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
function fail(message) {
    const error = Error(message);
    error.code = 'STORY_IDENTITY_REPAIR_UNSAFE';
    throw error;
}
function messagesById(chat, label) {
    if (!Array.isArray(chat)) fail(`${label}聊天记录格式无效。`);
    const found = new Map();
    for (const message of chat) {
        const id = message?.[STORY_MESSAGE_ID];
        if (id !== undefined && found.has(id)) fail(`${label}聊天中存在重复消息标识，不能修复候选关联。`);
        if (id !== undefined) found.set(id, message);
    }
    return found;
}
function candidates(message) {
    if (!message || typeof message !== 'object' || typeof message.mes !== 'string') fail('候选正文格式无效。');
    const selected = selectedCandidate(message);
    const swipes = message.swipes;
    if (Array.isArray(swipes)) {
        if (!swipes.length || Array.from(swipes).some(body => typeof body !== 'string')) fail('候选正文尚未保存完整。');
        return { selected, bodies: swipes, ids: Array.from(swipes, (_, swipe) => message.swipe_info?.[swipe]?.extra?.[STORY_CANDIDATE_ID]) };
    }
    if (selected !== 0) fail('没有候选列表的消息包含无效 Swipe 编号。');
    return { selected, bodies: [message.mes], ids: [message.extra?.[STORY_CANDIDATE_ID]] };
}
const bodyHash = (message, body) => sha256HexSync(JSON.stringify([
    message.name ?? '', !!message.is_user, !!message.is_system, body,
]));

/** Plan identity-only recovery from independently verified original candidates.
 * No message, index, text, variable or state is changed by this function.
 */
export function planCandidateIdentityRepair(chat, sourceChat, sourceIndex, currentIndex) {
    messagesById(chat, '当前');
    const sourceMessages = messagesById(sourceChat, '原始');
    for (const source of sourceChat) candidates(source);
    validateIndex(sourceIndex);
    validateIndex(currentIndex);
    const rows = [], mirrors = [];
    for (let floor = 0; floor < chat.length; floor++) {
        const message = chat[floor], current = candidates(message);
        const mirror = message.extra?.[STORY_CANDIDATE_ID];
        const affected = current.ids.some(id => !validId(id))
            || new Set(current.ids).size !== current.ids.length
            || mirror !== current.ids[current.selected];
        if (!affected) continue;
        const messageId = message[STORY_MESSAGE_ID];
        if (!validId(messageId)) fail('待修复消息缺少有效稳定标识，不能按楼层猜测。');
        const source = sourceMessages.get(messageId);
        if (!source) fail('原始备份没有同一消息，不能修复候选关联。');
        const original = candidates(source);
        if (original.ids.some(id => !validId(id)) || new Set(original.ids).size !== original.ids.length)
            fail('原始备份的候选标识缺失或重复，不能确认存档。');
        const sourceRow = sourceIndex.messages[messageId], currentRow = currentIndex.messages[messageId];
        if (!sourceRow || !currentRow) fail('索引没有待修复消息的候选关联。');
        const byHash = new Map();
        for (let swipe = 0; swipe < original.bodies.length; swipe++) {
            const cid = original.ids[swipe], entry = sourceRow.candidates[cid];
            if (!entry || entry.swipe !== swipe) fail('原始候选标识与原始索引的 Swipe 关联不一致。');
            const hash = bodyHash(source, original.bodies[swipe]);
            if (byHash.has(hash)) fail('原始备份中存在相同候选正文，无法唯一匹配。');
            byHash.set(hash, cid);
        }
        const matched = [], seenHashes = new Set();
        for (let swipe = 0; swipe < current.bodies.length; swipe++) {
            const hash = bodyHash(message, current.bodies[swipe]);
            if (seenHashes.has(hash)) fail('当前消息中存在相同候选正文，无法唯一匹配。');
            seenHashes.add(hash);
            const cid = byHash.get(hash);
            if (!cid) fail('当前候选正文无法唯一匹配原始备份，已停止修复。');
            const entry = currentRow.candidates[cid];
            if (!entry) fail('当前索引没有原始候选标识对应的状态，已停止修复。');
            matched.push(cid);
            if (current.ids[swipe] !== cid) rows.push({ floor, swipe, oldId: current.ids[swipe], newId: cid, stateId: entry.stateId });
        }
        const selectedId = matched[current.selected];
        if (mirror !== selectedId) mirrors.push({ floor, oldId: mirror, newId: selectedId });
    }
    return { version: 1, rows, mirrors };
}
