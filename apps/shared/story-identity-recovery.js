import { sha256HexSync } from '../tts/source-hash.js';
import { STORY_MESSAGE_ID, STORY_CANDIDATE_ID, selectedCandidate, validateIndex } from './story-chat-index.js';

const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
function fail(message, details = {}) {
    const error = Error(message);
    error.code = 'STORY_IDENTITY_REPAIR_UNSAFE';
    Object.assign(error, details);
    throw error;
}
function failAt(location, message, details = {}) {
    const label = location.source === 'original' ? '原聊天文件' : '当前聊天';
    const swipe = Number.isInteger(details.swipe) && details.swipe >= 0 ? ` · Swipe ${details.swipe + 1}` : '';
    fail(`${label} · 第 ${location.floor + 1} 楼${swipe}：${message}`, { ...location, ...details });
}
const dataType = value => value === undefined ? '缺失' : value === null ? 'null'
    : Array.isArray(value) ? '数组' : typeof value === 'object' ? '对象' : typeof value;
function messagesById(chat, label, source) {
    if (!Array.isArray(chat)) fail(`${label}聊天记录格式无效。`);
    const found = new Map();
    for (let floor = 0; floor < chat.length; floor++) {
        const message = chat[floor];
        const id = message?.[STORY_MESSAGE_ID];
        if (id !== undefined && found.has(id)) failAt({ source, floor }, `与第 ${found.get(id).floor + 1} 楼存在重复消息标识，不能修复候选关联。`);
        if (id !== undefined) found.set(id, { message, floor });
    }
    return found;
}
function candidates(message, location) {
    if (!message || typeof message !== 'object' || typeof message.mes !== 'string')
        failAt(location, `候选正文格式无效：当前正文为 ${dataType(message?.mes)}，应为文本。`, { field: 'mes' });
    const swipes = message.swipes;
    let selected;
    try { selected = selectedCandidate(message); }
    catch (error) {
        const swipe = message.swipe_id ?? 0;
        let detail = error.message, field = 'swipe_id';
        if (Number.isInteger(swipe) && swipe >= 0 && Array.isArray(swipes)) {
            if (swipe >= swipes.length) detail = `选中候选超出列表范围；列表只有 ${swipes.length} 个候选。`;
            else if (typeof swipes[swipe] !== 'string') { field = 'swipes'; detail = `选中候选正文为 ${dataType(swipes[swipe])}，应为文本。`; }
            else { field = 'mes'; detail = '当前显示正文与选中的候选正文不一致。'; }
        }
        failAt(location, `候选正文尚未保存完整。${detail} 请等待生成或切换完成后重新校验。`,
            { swipe: Number.isInteger(swipe) && swipe >= 0 ? swipe : undefined, field, code: error.code || 'STORY_IDENTITY_REPAIR_UNSAFE', cause: error });
    }
    if (Array.isArray(swipes)) {
        for (let swipe = 0; swipe < swipes.length; swipe++) {
            if (typeof swipes[swipe] !== 'string') failAt(location,
                `候选正文尚未保存完整：此候选正文为 ${dataType(swipes[swipe])}，应为文本。请核对该楼的备用回复数据。`, { swipe, field: 'swipes' });
        }
        return { selected, bodies: swipes, ids: Array.from(swipes, (_, swipe) => message.swipe_info?.[swipe]?.extra?.[STORY_CANDIDATE_ID]) };
    }
    if (selected !== 0) failAt(location, '没有候选列表的消息包含无效 Swipe 编号。', { swipe: selected, field: 'swipe_id' });
    return { selected, bodies: [message.mes], ids: [message.extra?.[STORY_CANDIDATE_ID]] };
}
const bodyHash = (message, body) => sha256HexSync(JSON.stringify([
    message.name ?? '', !!message.is_user, !!message.is_system, body,
]));

/** Plan identity-only recovery from independently verified original candidates.
 * No message, index, text, variable or state is changed by this function.
 */
export function planCandidateIdentityRepair(chat, sourceChat, sourceIndex, currentIndex) {
    messagesById(chat, '当前', 'current');
    const sourceMessages = messagesById(sourceChat, '原始', 'original');
    for (let floor = 0; floor < sourceChat.length; floor++) candidates(sourceChat[floor], { source: 'original', floor });
    validateIndex(sourceIndex);
    validateIndex(currentIndex);
    const rows = [], mirrors = [];
    for (let floor = 0; floor < chat.length; floor++) {
        const location = { source: 'current', floor };
        const message = chat[floor], current = candidates(message, location);
        const mirror = message.extra?.[STORY_CANDIDATE_ID];
        const affected = current.ids.some(id => !validId(id))
            || new Set(current.ids).size !== current.ids.length
            || mirror !== current.ids[current.selected];
        if (!affected) continue;
        const messageId = message[STORY_MESSAGE_ID];
        if (!validId(messageId)) failAt(location, '待修复消息缺少有效稳定标识，不能按楼层猜测。');
        const sourceRecord = sourceMessages.get(messageId), source = sourceRecord?.message;
        if (!source) failAt(location, '原始备份没有同一消息，不能修复候选关联。');
        const originalLocation = { source: 'original', floor: sourceRecord.floor };
        const original = candidates(source, originalLocation);
        if (original.ids.some(id => !validId(id)) || new Set(original.ids).size !== original.ids.length)
            failAt(originalLocation, '原始备份的候选标识缺失或重复，不能确认存档。');
        const sourceRow = sourceIndex.messages[messageId], currentRow = currentIndex.messages[messageId];
        if (!sourceRow || !currentRow) failAt(location, '索引没有待修复消息的候选关联。');
        const byHash = new Map();
        for (let swipe = 0; swipe < original.bodies.length; swipe++) {
            const cid = original.ids[swipe], entry = sourceRow.candidates[cid];
            if (!entry || entry.swipe !== swipe) failAt(originalLocation, '原始候选标识与原始索引的 Swipe 关联不一致。', { swipe });
            const hash = bodyHash(source, original.bodies[swipe]);
            if (byHash.has(hash)) failAt(originalLocation, '原始备份中存在相同候选正文，无法唯一匹配。', { swipe });
            byHash.set(hash, cid);
        }
        const matched = [], seenHashes = new Set();
        for (let swipe = 0; swipe < current.bodies.length; swipe++) {
            const hash = bodyHash(message, current.bodies[swipe]);
            if (seenHashes.has(hash)) failAt(location, '当前消息中存在相同候选正文，无法唯一匹配。', { swipe });
            seenHashes.add(hash);
            const cid = byHash.get(hash);
            if (!cid) failAt(location, '当前候选正文无法唯一匹配原始备份，已停止修复。', { swipe });
            const entry = currentRow.candidates[cid];
            if (!entry) failAt(location, '当前索引没有原始候选标识对应的状态，已停止修复。', { swipe });
            matched.push(cid);
            if (current.ids[swipe] !== cid) rows.push({ floor, swipe, oldId: current.ids[swipe], newId: cid, stateId: entry.stateId });
        }
        const selectedId = matched[current.selected];
        if (mirror !== selectedId) mirrors.push({ floor, oldId: mirror, newId: selectedId });
    }
    return { version: 1, rows, mirrors };
}
