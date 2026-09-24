import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity, chatPath } from '../shared/operations.js';
import { chatRevisions } from '../shared/message-revision.js';
import { getReference, setReference, STORY_REFERENCE_KEY } from '../shared/story-message-refs.js';
import { OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS } from './storage.js';
import { restoreExternalState2SnapshotToFloor } from './native-bridge.js';

export const STORY_STORAGE_KEY = 'amin_os_story_storage_v2';
const OWNER = 'amin-os/story-v2';
const STATE_ID = /^sha256:[a-f0-9]{64}$/u;
const JSON_ROOTS = new Set([...OWNED_VARIABLE_ROOTS, ...Object.values(NATIVE_VARIABLE_ROOTS)]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertMarker(ctx) {
    const marker = ctx?.chatMetadata?.[STORY_STORAGE_KEY];
    if (marker === undefined) return null;
    if (!plain(marker) || marker.version !== 2 || marker.owner !== OWNER || !STATE_ID.test(marker.baseStateId ?? ''))
        throw failure('STORY_MARKER_INVALID', '当前聊天的外置剧情存储标记无效，已停止读取。');
    if (marker.backups !== undefined && (!Array.isArray(marker.backups) || marker.backups.length > 5
        || marker.backups.some(item => !plain(item) || !STATE_ID.test(item.stateId ?? '')
            || typeof item.label !== 'string' || item.label.length > 160
            || typeof item.at !== 'number' || !Number.isFinite(item.at)))) {
        throw failure('STORY_MARKER_INVALID', '当前聊天的外置剧情备份目录无效，已停止读取。');
    }
    return marker;
}

function contextToken(ctx) {
    return {
        metadata: ctx.chatMetadata,
        integrity: ctx.chatMetadata.integrity,
        identity: chatIdentity(ctx),
        revisions: JSON.stringify(chatRevisions(ctx.chat)),
        references: referenceFingerprint(ctx),
    };
}

function referenceFingerprint(ctx) {
    return JSON.stringify([
        ctx.chatMetadata[STORY_STORAGE_KEY] ?? null,
        ctx.chat.map(message => [message?.extra?.[STORY_REFERENCE_KEY] ?? null,
            (message?.swipe_info ?? []).map(info => info?.extra?.[STORY_REFERENCE_KEY] ?? null)]),
    ]);
}

function assertCurrent(getContext, token) {
    const ctx = getContext();
    assertChatReady(ctx);
    if (!ctx?.chatMetadata || ctx.chatMetadata !== token.metadata
        || ctx.chatMetadata.integrity !== token.integrity
        || chatIdentity(ctx) !== token.identity
        || JSON.stringify(chatRevisions(ctx.chat)) !== token.revisions
        || referenceFingerprint(ctx) !== token.references) {
        throw failure('STORY_CHAT_CHANGED', '聊天或消息候选已变化，外置剧情状态未关联到新聊天。');
    }
    return ctx;
}

function clone(value) { return structuredClone(value); }

function currentState(ctx) {
    const metadata = ctx.chatMetadata;
    if (!plain(metadata?.variables ?? {}) || !plain(metadata?.LWB_RULES_V2 ?? {}))
        throw failure('STORY_STATE_INVALID', '小白变量或规则格式无效，无法保存剧情状态。');
    const variables = {}, rules = {};
    for (const root of JSON_ROOTS) {
        if (own(metadata.variables ?? {}, root)) variables[root] = clone(metadata.variables[root]);
    }
    for (const [path, rule] of Object.entries(metadata.LWB_RULES_V2 ?? {})) {
        if (JSON_ROOTS.has(path.split(/[.\[]/, 1)[0])) rules[path] = clone(rule);
    }
    return { variables, rules };
}

// LWB stores most Amin roots as serialized JSON strings. Decode them inside
// the graph so a one-field change can be stored as a delta, then restore the
// original variable *type* for the native State 2.0 engine.
function encodeState(state) {
    const variables = clone(state.variables), jsonStringRoots = [];
    for (const root of JSON_ROOTS) {
        if (typeof variables[root] !== 'string') continue;
        try {
            variables[root] = JSON.parse(variables[root]);
            jsonStringRoots.push(root);
        } catch { /* A non-JSON native value stays an ordinary string. */ }
    }
    return { version: 2, variables, rules: clone(state.rules), jsonStringRoots: jsonStringRoots.sort() };
}

function decodeState(record) {
    if (!plain(record) || record.version !== 2 || !plain(record.variables) || !plain(record.rules)
        || Object.keys(record.variables).some(root => !JSON_ROOTS.has(root))
        || Object.keys(record.rules).some(path => !JSON_ROOTS.has(path.split(/[.\[]/, 1)[0]))
        || !Array.isArray(record.jsonStringRoots)
        || record.jsonStringRoots.some(root => typeof root !== 'string' || !JSON_ROOTS.has(root) || !own(record.variables, root))
        || new Set(record.jsonStringRoots).size !== record.jsonStringRoots.length) {
        throw failure('STORY_STATE_CORRUPT', '外置剧情状态结构无效，已停止历史回放。');
    }
    const variables = clone(record.variables);
    for (const root of record.jsonStringRoots) variables[root] = JSON.stringify(variables[root]);
    return { variables, rules: clone(record.rules) };
}

function candidateView(message, swipeId) {
    if (!Array.isArray(message?.swipes)) return message;
    return { ...message, mes: message.swipes[swipeId], swipe_id: swipeId };
}

function linkedIds(ctx, marker) {
    const ids = new Set([marker.baseStateId, ...(marker.backups ?? []).map(item => item.stateId)]);
    for (const message of ctx.chat) {
        const candidates = Array.isArray(message.swipes) ? message.swipes.length : 1;
        for (let swipeId = 0; swipeId < candidates; swipeId++) {
            const reference = getReference(candidateView(message, swipeId));
            if (reference) ids.add(reference.stateId);
        }
    }
    return ids;
}

/** Coordinate immutable external states and compact refs in selected messages. */
export function createStoryStorage(getContext, {
    graph,
    restoreState = restoreExternalState2SnapshotToFloor,
    available = () => true,
    host = globalThis,
    document = globalThis.document,
} = {}) {
    if (typeof getContext !== 'function' || typeof graph?.save !== 'function' || typeof graph?.load !== 'function'
        || typeof graph?.exportClosure !== 'function' || typeof graph?.importClosure !== 'function')
        throw new TypeError('外置剧情存储需要当前聊天接口与完整状态图。');
    let busy = false;

    function current() {
        const ctx = getContext();
        assertChatReady(ctx);
        if (!plain(ctx?.chatMetadata) || !Array.isArray(ctx?.chat)
            || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null)
            throw failure('STORY_NO_CHAT', '请先打开已经加载完成的聊天。');
        return ctx;
    }

    function requireAvailable() {
        if (!available()) throw failure('STORY_STORE_UNAVAILABLE', '外置剧情文件存储不可用，无法安全关联消息楼层。');
    }

    function refsTo(ctx, target, marker) {
        if (!Number.isSafeInteger(target) || target < -1 || target >= ctx.chat.length)
            throw failure('STORY_FLOOR_INVALID', '剧情状态的目标楼层无效。');
        let parentStateId = marker.baseStateId;
        for (let index = 0; index <= target; index++) {
            const reference = getReference(ctx.chat[index], { parentStateId });
            // The host can save a user/system turn before Amin gets its save
            // hook. Those turns do not execute LWB model updates; inherit the
            // preceding state until their own short ref is captured.
            if (!reference && (ctx.chat[index]?.is_user || ctx.chat[index]?.is_system)) continue;
            if (!reference) throw failure('STORY_REFERENCE_MISSING', `第 ${index + 1} 楼缺少外置剧情状态引用。`);
            if (!STATE_ID.test(reference.stateId))
                throw failure('STORY_REFERENCE_INVALID', `第 ${index + 1} 楼的外置剧情状态编号无效。`);
            parentStateId = reference.stateId;
        }
        return parentStateId;
    }

    async function locked(work) {
        if (busy) throw failure('STORY_BUSY', '当前聊天的外置剧情状态正在处理，请稍后。');
        busy = true;
        try { return await work(); }
        finally { busy = false; }
    }

    async function enable() {
        return locked(async () => {
            requireAvailable();
            const ctx = current(), existing = assertMarker(ctx);
            if (existing) {
                const token = contextToken(ctx);
                await graph.load(existing.baseStateId);
                assertCurrent(getContext, token);
                return { enabled: true, changed: false, baseStateId: existing.baseStateId };
            }
            if (ctx.extensionSettings?.LittleWhiteBox?.variablesMode !== '2.0')
                throw failure('STORY_STATE2_REQUIRED', '请先启用小白 X 变量管理 2.0。');
            if (ctx.chat.length > 1)
                throw failure('STORY_OLD_CHAT', '已有多楼层聊天无法自动补齐外置剧情历史；请在新聊天中启用。');
            const token = contextToken(ctx), state = currentState(ctx);
            const baseStateId = await graph.save(encodeState(state));
            const now = assertCurrent(getContext, token);
            if (JSON.stringify(currentState(now)) !== JSON.stringify(state))
                throw failure('STORY_STATE_CHANGED', '保存期间剧情变量已变化，请重试。');
            if (now.chat.length === 1) setReference(now.chat[0], baseStateId, { parentStateId: baseStateId });
            now.chatMetadata[STORY_STORAGE_KEY] = { version: 2, owner: OWNER, baseStateId, backups: [] };
            return { enabled: true, changed: true, baseStateId };
        });
    }

    async function capture() {
        return locked(async () => {
            requireAvailable();
            const ctx = current(), marker = assertMarker(ctx);
            if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
            const floor = ctx.chat.length - 1;
            if (floor < 0) return { changed: false, stateId: marker.baseStateId };
            const parentStateId = refsTo(ctx, floor - 1, marker);
            // Existing mismatched refs mean this floor was edited or another
            // candidate selected. A new candidate may have no ref yet.
            const old = getReference(ctx.chat[floor], { parentStateId });
            const token = contextToken(ctx), state = currentState(ctx);
            const stateId = await graph.save(encodeState(state), { parentId: parentStateId });
            const now = assertCurrent(getContext, token);
            if (JSON.stringify(currentState(now)) !== JSON.stringify(state))
                throw failure('STORY_STATE_CHANGED', '保存期间剧情变量已变化，请重试。');
            if (old?.stateId === stateId) return { changed: false, stateId };
            setReference(now.chat[floor], stateId, { parentStateId });
            return { changed: true, stateId };
        });
    }

    async function readFloor(index) {
        requireAvailable();
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx);
        const stateId = refsTo(ctx, index, marker);
        const snapshot = decodeState(await graph.load(stateId));
        assertCurrent(getContext, token);
        return { ...snapshot, stateId, floor: index };
    }

    async function readState(stateId) {
        requireAvailable();
        if (!STATE_ID.test(stateId ?? '')) throw failure('STORY_STATE_INVALID', '外置剧情状态编号无效。');
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx);
        let linked = stateId === marker.baseStateId || (marker.backups ?? []).some(item => item.stateId === stateId);
        if (!linked) {
            for (const message of ctx.chat) {
                const candidates = Array.isArray(message.swipes) ? message.swipes.length : 1;
                for (let swipeId = 0; swipeId < candidates; swipeId++) {
                    if (getReference(candidateView(message, swipeId))?.stateId === stateId) linked = true;
                }
            }
        }
        if (!linked) throw failure('STORY_STATE_UNLINKED', '该剧情状态不属于当前聊天或备份。');
        const snapshot = decodeState(await graph.load(stateId));
        assertCurrent(getContext, token);
        return snapshot;
    }

    async function restoreFloor(index) {
        const ctx = current();
        if (index !== ctx.chat.length - 1)
            throw failure('STORY_RESTORE_TAIL', '只能在当前分支末尾恢复剧情变量；查看旧楼层请使用只读历史。');
        const token = contextToken(ctx);
        const snapshot = await readFloor(index);
        assertCurrent(getContext, token);
        const expected = { metadata: token.metadata, identity: token.identity, path: JSON.stringify(chatPath(ctx.chat)) };
        const isCurrent = () => { try { assertCurrent(getContext, token); return true; } catch { return false; } };
        const result = await restoreState(index, snapshot, { context: getContext, host, document, expected, isCurrent });
        assertCurrent(getContext, token);
        if (!result?.restored || result.stale) throw failure('STORY_RESTORE_FAILED', '外置剧情状态恢复未完成，请重试。');
        return { ...result, stateId: snapshot.stateId };
    }

    async function restoreBeforeCandidate(kind) {
        if (!['regenerate', 'swipe'].includes(kind))
            throw failure('STORY_GENERATION_KIND', '仅能为重新生成或新候选恢复上一楼变量。');
        const ctx = current(), tail = ctx.chat.length - 1;
        if (tail < 1 || ctx.chat[tail]?.is_user || ctx.chat[tail]?.is_system)
            throw failure('STORY_GENERATION_FLOOR', '当前末楼不是可重新生成的回复。');
        const token = contextToken(ctx);
        const snapshot = await readFloor(tail - 1);
        assertCurrent(getContext, token);
        const expected = { metadata: token.metadata, identity: token.identity, path: JSON.stringify(chatPath(ctx.chat)) };
        const isCurrent = () => { try { assertCurrent(getContext, token); return true; } catch { return false; } };
        const result = await restoreState(tail - 1, snapshot,
            { context: getContext, host, document, expected, isCurrent, forGeneration: true });
        assertCurrent(getContext, token);
        if (!result?.restored || result.stale)
            throw failure('STORY_RESTORE_FAILED', '上一楼剧情状态未恢复，已停止重新生成。');
        return { ...result, stateId: snapshot.stateId };
    }

    async function exportStory() {
        requireAvailable();
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx), ids = linkedIds(ctx, marker);
        const graphBundle = await graph.exportClosure([...ids]);
        assertCurrent(getContext, token);
        return { version: 2, marker: clone(marker), graph: graphBundle };
    }

    async function importStory(bundle) {
        requireAvailable();
        if (!plain(bundle) || bundle.version !== 2 || !plain(bundle.marker) || !plain(bundle.graph)
            || !Array.isArray(bundle.graph.roots) || !bundle.graph.roots.includes(bundle.marker.baseStateId))
            throw failure('STORY_IMPORT_INVALID', '外置剧情数据包格式无效。');
        assertMarker({ chatMetadata: { [STORY_STORAGE_KEY]: bundle.marker } });
        const ctx = current(), token = contextToken(ctx), marker = assertMarker(ctx);
        if (marker && marker.baseStateId !== bundle.marker.baseStateId)
            throw failure('STORY_IMPORT_CHAT_MISMATCH', '该剧情数据包属于另一条聊天，无法接到当前分支。');
        if (marker && [...linkedIds(ctx, marker)].some(id => !bundle.graph.roots.includes(id)))
            throw failure('STORY_IMPORT_INCOMPLETE', '剧情数据包缺少当前聊天引用的楼层或备份状态。');
        await graph.importClosure(bundle.graph);
        assertCurrent(getContext, token);
        return { imported: true, roots: bundle.graph.roots.length };
    }

    function status() {
        const ctx = getContext();
        try {
            const marker = assertMarker(ctx);
            return {
                enabled: !!marker,
                available: !!available(),
                baseStateId: marker?.baseStateId ?? null,
                message: marker ? '当前聊天已使用外置剧情状态。' : '当前聊天尚未启用外置剧情状态。',
            };
        } catch (error) {
            return { enabled: false, available: !!available(), message: error.message, error: error.code ?? 'STORY_STORAGE_ERROR' };
        }
    }

    return { enable, capture, readFloor, readState, restoreFloor, restoreBeforeCandidate, exportStory, importStory, status };
}
