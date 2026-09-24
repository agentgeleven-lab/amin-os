import { messageRevision } from './message-revision.js';

// TauriTavern stores the selected swipe's extra in both places. When the user
// changes swipes it replaces message.extra with swipe_info[swipe_id].extra.
export const STORY_REFERENCE_KEY = 'amin_story_v2';

const revisionPattern = /^sha256:[0-9a-f]{64}$/u;
const stateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const swipeIdOf = message => message?.swipe_id ?? 0;

export class StoryReferenceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StoryReferenceError';
        this.code = code;
    }
}

function assertMessage(message) {
    if (!isObject(message) || typeof message.mes !== 'string') {
        throw new StoryReferenceError('INVALID_MESSAGE', '消息内容尚未准备好，无法读取剧情状态引用。');
    }
    const swipeId = swipeIdOf(message);
    if (!Number.isInteger(swipeId) || swipeId < 0) {
        throw new StoryReferenceError('INVALID_CANDIDATE', '当前回复候选编号无效。');
    }
    // A new swipe can temporarily inherit the previous swipe's top-level
    // extra. Never attach or resolve a state before its own text exists.
    if (Array.isArray(message.swipes) && (
        typeof message.swipes[swipeId] !== 'string' || message.swipes[swipeId] !== message.mes
    )) {
        throw new StoryReferenceError('INCOMPLETE_CANDIDATE', '当前回复候选尚未保存完整，不能关联剧情状态。');
    }
    return swipeId;
}

function candidateExtra(message, swipeId, create) {
    if (!Array.isArray(message.swipes)) {
        if (create && !isObject(message.extra)) message.extra = {};
        return isObject(message.extra) ? message.extra : null;
    }
    if (!Array.isArray(message.swipe_info)) {
        if (!create) return null;
        message.swipe_info = [];
    }
    if (!isObject(message.swipe_info[swipeId])) {
        if (!create) return null;
        message.swipe_info[swipeId] = {
            send_date: message.send_date,
            gen_started: message.gen_started,
            gen_finished: message.gen_finished,
            extra: {},
        };
    }
    const info = message.swipe_info[swipeId];
    if (create && !isObject(info.extra)) info.extra = {};
    return isObject(info.extra) ? info.extra : null;
}

function validStateId(value) {
    return typeof value === 'string' && stateIdPattern.test(value);
}

function assertStateId(value) {
    if (!validStateId(value)) throw new StoryReferenceError('INVALID_STATE_ID', '剧情状态编号无效。');
}

/**
 * Read the selected candidate only. Missing refs return null; malformed or
 * edited refs fail closed so callers can distinguish a legacy floor from a
 * damaged/stale reference. Passing parentStateId checks the state chain.
 */
export function getReference(message, options = {}) {
    const swipeId = assertMessage(message);
    const extra = candidateExtra(message, swipeId, false);
    const reference = extra?.[STORY_REFERENCE_KEY];
    if (reference === undefined) return null;
    if (!isObject(reference) || reference.version !== 2 || !validStateId(reference.stateId)
        || !revisionPattern.test(reference.revision) || reference.swipeId !== swipeId
        || !(reference.parentStateId === null || validStateId(reference.parentStateId))) {
        throw new StoryReferenceError('INVALID_REFERENCE', '该楼层的剧情状态引用格式无效。');
    }
    if (reference.revision !== messageRevision(message)) {
        throw new StoryReferenceError('STALE_REFERENCE', '该楼层内容已变化，原剧情状态引用失效。');
    }
    if (Object.hasOwn(options, 'parentStateId') && reference.parentStateId !== options.parentStateId) {
        throw new StoryReferenceError('PARENT_MISMATCH', '该楼层之前的剧情状态已变化，不能使用后续状态引用。');
    }
    return {
        version: 2,
        stateId: reference.stateId,
        revision: reference.revision,
        swipeId: reference.swipeId,
        parentStateId: reference.parentStateId,
    };
}

/**
 * Attach a compact external-state pointer to one completed candidate. The
 * parent state is recorded to allow ordered branch validation during replay.
 */
export function setReference(message, stateId, { parentStateId = null } = {}) {
    const swipeId = assertMessage(message);
    assertStateId(stateId);
    if (parentStateId !== null) assertStateId(parentStateId);
    const reference = {
        version: 2,
        stateId,
        revision: messageRevision(message),
        swipeId,
        parentStateId,
    };
    const extra = candidateExtra(message, swipeId, true);
    if (!isObject(message.extra)) message.extra = {};
    // TT's syncMesToSwipe and syncSwipeToMes copy these extras, so keep both
    // representations equal. No other candidate's swipe_info is touched.
    message.extra[STORY_REFERENCE_KEY] = { ...reference };
    if (extra !== message.extra) extra[STORY_REFERENCE_KEY] = { ...reference };
    return { ...reference };
}
