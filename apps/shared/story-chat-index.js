import { uuid } from '../../uuid.js';
import { getReference, STORY_REFERENCE_KEY } from './story-message-refs.js';

// These identities survive body edits and are copied along with branch messages.
// Candidate identity belongs to swipe_info, never an inherited top-level extra.
export const STORY_MESSAGE_ID = 'amin_story_message_id';
export const STORY_CANDIDATE_ID = 'amin_story_candidate_id';
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const statePattern = /^sha256:[a-f0-9]{64}$/;
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (message, code) => { const error = Error(message); if (code) error.code = code; throw error; };
export function selectedCandidate(message) {
    const swipe = message.swipe_id ?? 0;
    if (!Number.isInteger(swipe) || swipe < 0) fail('当前 Swipe 编号无效。');
    if (Array.isArray(message.swipes) && (typeof message.swipes[swipe] !== 'string' || message.swipes[swipe] !== message.mes))
        fail('当前回复候选尚未保存完整，请等待生成或切换完成。', 'INCOMPLETE_CANDIDATE');
    return swipe;
}
function extraAt(message, swipe, create = false) {
    if (!Array.isArray(message.swipes)) {
        if (create) message.extra ??= {};
        return message.extra;
    }
    if (create) { message.swipe_info ??= []; message.swipe_info[swipe] ??= {}; message.swipe_info[swipe].extra ??= {}; }
    return message.swipe_info?.[swipe]?.extra;
}
export function candidateId(message, swipe = selectedCandidate(message)) {
    return extraAt(message, swipe)?.[STORY_CANDIDATE_ID];
}
export function validateIndex(value) {
    if (!plain(value) || value.kind !== 'amin-story-index' || value.version !== 1 || typeof value.chat !== 'string'
        || !plain(value.order) || !plain(value.messages)) fail('聊天剧情索引格式无效。');
    for (const [id, row] of Object.entries(value.messages)) {
        if (!idPattern.test(id) || !plain(row) || !plain(row.candidates)) fail('聊天剧情索引消息标识无效。');
        for (const [cid, entry] of Object.entries(row.candidates)) {
            if (!idPattern.test(cid) || !plain(entry) || !Number.isInteger(entry.swipe) || entry.swipe < 0
                || entry.stateId !== null && !statePattern.test(entry.stateId)) fail('聊天剧情索引 Swipe 记录无效。');
        }
    }
    for (const [floor, id] of Object.entries(value.order)) {
        if (!/^(0|[1-9]\d*)$/.test(floor) || !Object.hasOwn(value.messages, id)) fail('聊天剧情索引楼层无效。');
    }
    return value;
}

// Work on clones. The caller commits the identities only after index files have
// been persisted and the live chat token has been checked again.
export function buildIndex(chat, identity, previous = null, previousId = null) {
    const copies = chat.map(message => ({ ...message, extra: { ...message.extra },
        ...(Array.isArray(message.swipe_info) ? { swipe_info: message.swipe_info.map(info => info ? { ...info, extra: { ...info.extra } } : info) } : {}) })), seen = new Set();
    const index = { kind: 'amin-story-index', version: 1, chat: identity,
        inheritedFrom: previous && previous.chat !== identity ? { chat: previous.chat, indexId: previousId } : previous?.inheritedFrom ?? null,
        order: {}, messages: {} };
    for (let floor = 0; floor < copies.length; floor++) {
        const message = copies[floor];
        let id = message[STORY_MESSAGE_ID];
        if (id !== undefined && !idPattern.test(id)) fail('消息的稳定标识无效，不能按楼层猜测存档。');
        if (seen.has(id)) fail('聊天中出现重复消息标识，已停止关联以防串档。');
        if (!id) id = message[STORY_MESSAGE_ID] = uuid();
        seen.add(id);
        const row = { selected: message.swipe_id ?? 0, candidates: {} }, candidateIds = new Set();
        const count = Array.isArray(message.swipes) ? message.swipes.length : 1;
        for (let swipe = 0; swipe < count; swipe++) {
            const extra = extraAt(message, swipe, true);
            // ST introduces swipes lazily; candidate zero inherits the original
            // non-swipe extra only when no candidate data was recorded yet.
            if (swipe === 0 && !extra[STORY_CANDIDATE_ID] && previous?.messages[id]
                && message.extra?.[STORY_CANDIDATE_ID]) extra[STORY_CANDIDATE_ID] = message.extra[STORY_CANDIDATE_ID];
            let cid = extra[STORY_CANDIDATE_ID];
            if (cid !== undefined && !idPattern.test(cid)) fail('Swipe 稳定标识无效。');
            if (candidateIds.has(cid)) {
                const saved = previous?.messages[id]?.candidates ?? {};
                const lastSavedSwipe = Math.max(-1, ...Object.values(saved).map(entry => entry.swipe));
                // TT may clone the current extra when appending generated swipes.
                // Only an appended slot can receive a fresh identity this way.
                if (swipe > lastSavedSwipe && previous) cid = undefined;
                else fail('同一消息出现重复 Swipe 标识，不能确认对应存档。');
            }
            if (!cid) cid = extra[STORY_CANDIDATE_ID] = uuid();
            candidateIds.add(cid);
            let stateId = previous?.messages[id]?.candidates[cid]?.stateId ?? null;
            if (!previous) {
                const candidate = Array.isArray(message.swipes) ? { ...message, mes: message.swipes[swipe], swipe_id: swipe } : message;
                // Migration preserves the original state; body formatting is no
                // longer a reason to discard an otherwise valid stored record.
                stateId = getReference(candidate, { allowStale: true })?.stateId ?? null;
            }
            row.candidates[cid] = { swipe, stateId };
            delete extra[STORY_REFERENCE_KEY];
        }
        message.extra ??= {};
        delete message.extra[STORY_REFERENCE_KEY];
        const selected = extraAt(message, message.swipe_id ?? 0);
        if (selected?.[STORY_CANDIDATE_ID]) message.extra[STORY_CANDIDATE_ID] = selected[STORY_CANDIDATE_ID];
        else delete message.extra[STORY_CANDIDATE_ID];
        index.order[floor] = id; index.messages[id] = row;
    }
    return { index, copies };
}
export function commitIdentities(chat, copies) {
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i], copy = copies[i];
        message[STORY_MESSAGE_ID] = copy[STORY_MESSAGE_ID];
        message.extra ??= {};
        delete message.extra[STORY_REFERENCE_KEY];
        if (copy.extra[STORY_CANDIDATE_ID]) message.extra[STORY_CANDIDATE_ID] = copy.extra[STORY_CANDIDATE_ID];
        else delete message.extra[STORY_CANDIDATE_ID];
        for (let swipe = 0; swipe < (copy.swipes?.length ?? 0); swipe++) {
            const extra = extraAt(message, swipe, true);
            extra[STORY_CANDIDATE_ID] = extraAt(copy, swipe)[STORY_CANDIDATE_ID];
            delete extra[STORY_REFERENCE_KEY];
        }
    }
}
export function indexedState(index, message) {
    const swipe = selectedCandidate(message), id = message[STORY_MESSAGE_ID], cid = candidateId(message, swipe);
    if (cid && Array.isArray(message.swipes)
        && message.swipes.filter((_, i) => candidateId(message, i) === cid).length > 1)
        fail('Swipe 标识尚未独立，不能读取复制过来的旧候选存档。', 'INCOMPLETE_CANDIDATE');
    return index.messages[id]?.candidates[cid]?.stateId ?? null;
}
export function indexStateIds(index) {
    return [...new Set(Object.values(index.messages).flatMap(row => Object.values(row.candidates).map(c => c.stateId)).filter(Boolean))];
}
