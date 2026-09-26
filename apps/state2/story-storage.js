import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity, chatPath } from '../shared/operations.js';
import { chatRevisions } from '../shared/message-revision.js';
import { getReference, setReference, STORY_REFERENCE_KEY } from '../shared/story-message-refs.js';
import { OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS } from './storage.js';
import { restoreExternalState2SnapshotToFloor } from './native-bridge.js';
import { buildIndex, commitIdentities, validateIndex, indexedState, indexStateIds, candidateId, selectedCandidate, STORY_MESSAGE_ID, STORY_CANDIDATE_ID } from '../shared/story-chat-index.js';

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
    if (marker.indexId !== undefined && !STATE_ID.test(marker.indexId))
        throw failure('STORY_MARKER_INVALID', '当前聊天的外置剧情索引编号无效。');
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
        candidates: ctx.chat.map(message => ({ system: !!message.is_system,
            swipes: Array.isArray(message.swipes) ? message.swipes.slice() : null })),
    };
}

function referenceFingerprint(ctx) {
    return JSON.stringify([
        ctx.chatMetadata[STORY_STORAGE_KEY] ?? null,
        ctx.chat.map(message => [message?.[STORY_MESSAGE_ID] ?? null, message?.extra?.[STORY_CANDIDATE_ID] ?? null, message?.extra?.[STORY_REFERENCE_KEY] ?? null,
            (message?.swipe_info ?? []).map(info => [info?.extra?.[STORY_REFERENCE_KEY] ?? null, info?.extra?.[STORY_CANDIDATE_ID] ?? null])]),
    ]);
}

function assertCurrent(getContext, token) {
    const ctx = getContext();
    assertChatReady(ctx);
    if (!ctx?.chatMetadata || ctx.chatMetadata !== token.metadata
        || ctx.chatMetadata.integrity !== token.integrity
        || chatIdentity(ctx) !== token.identity
        || JSON.stringify(chatRevisions(ctx.chat)) !== token.revisions
        || referenceFingerprint(ctx) !== token.references
        || ctx.chat.some((message, index) => {
            const before = token.candidates[index], swipes = Array.isArray(message.swipes) ? message.swipes : null;
            return !before || before.system !== !!message.is_system || (before.swipes === null) !== (swipes === null)
                || swipes && (swipes.length !== before.swipes.length || swipes.some((text, i) => text !== before.swipes[i]));
        })) {
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
    const captureReceipts = new WeakMap();

    function completedCapture(ctx, state, result, saveReceipt) {
        if (!saveReceipt) return result;
        const receipt = Object.freeze({});
        captureReceipts.set(receipt, {
            token: contextToken(ctx), state: JSON.stringify(state),
        });
        return { ...result, receipt };
    }

    /** A receipt is private, one-use, and never serialized into a chat/file. */
    function consumeCaptureReceipt(receipt, ctx) {
        const saved = receipt && captureReceipts.get(receipt);
        if (!saved) return null;
        captureReceipts.delete(receipt);
        requireAvailable();
        const assertContext = () => {
            const now = assertCurrent(getContext, saved.token);
            if (ctx?.chatMetadata !== saved.token.metadata || chatIdentity(ctx) !== saved.token.identity)
                throw failure('STORY_CHAT_CHANGED', '聊天或消息候选已变化，外置剧情状态未关联到新聊天。');
            return now;
        };
        if (JSON.stringify(currentState(assertContext())) !== saved.state) return null;
        return () => {
            if (JSON.stringify(currentState(assertContext())) !== saved.state)
                throw failure('STORY_STATE_CHANGED', '保存准备期间剧情变量已变化，请重试。');
        };
    }

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

    async function loadIndex(marker) { return marker.indexId ? validateIndex(await graph.load(marker.indexId)) : null; }
    function stateFromIndex(ctx, target, marker, index) {
        if (!Number.isSafeInteger(target) || target < -1 || target >= ctx.chat.length)
            throw failure('STORY_FLOOR_INVALID', '剧情状态的目标楼层无效。');
        let stateId = marker.baseStateId;
        const seen = new Set();
        for (let floor = 0; floor <= target; floor++) {
            const message = ctx.chat[floor], id = message[STORY_MESSAGE_ID];
            if (id && seen.has(id)) throw failure('STORY_DUPLICATE_MESSAGE', '消息标识重复，不能确定剧情存档。');
            if (id) seen.add(id);
            const saved = indexedState(index, message);
            if (saved) stateId = saved;
            else if (!message.is_user && !message.is_system) throw failure('STORY_REFERENCE_MISSING', `第 ${floor + 1} 楼的当前 Swipe 尚无剧情存档。`);
        }
        return stateId;
    }
    async function allLinkedIds(ctx, marker) {
        if (!marker.indexId) return linkedIds(ctx, marker);
        const index = await loadIndex(marker);
        // Only records still reachable from this branch are exported/readable.
        const projected = buildIndex(ctx.chat, chatIdentity(ctx), index, marker.indexId).index;
        return new Set([marker.baseStateId, marker.indexId, ...(marker.backups ?? []).map(b => b.stateId), ...indexStateIds(projected)]);
    }
    async function ensureIndex() {
        return locked(async () => {
            requireAvailable();
            const ctx = current(), marker = assertMarker(ctx);
            if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
            const token = contextToken(ctx), old = await loadIndex(marker);
            const { index, copies } = buildIndex(ctx.chat, chatIdentity(ctx), old, marker.indexId);
            if (!old) {
                // Verify every migrated state before removing old pointers.
                await visitStates([marker.baseStateId, ...indexStateIds(index)], state => { decodeState(state); });
            }
            const indexId = await graph.save(index, { parentId: marker.indexId ?? null });
            const now = assertCurrent(getContext, token);
            if (indexId === marker.indexId) return { changed: false };
            commitIdentities(now.chat, copies);
            now.chatMetadata[STORY_STORAGE_KEY] = { ...marker, indexId };
            return { changed: true, indexId };
        });
    }

    async function captureIndexed(ctx, marker, saveReceipt) {
        const token = contextToken(ctx), old = await loadIndex(marker);
        const { index, copies } = buildIndex(ctx.chat, chatIdentity(ctx), old, marker.indexId);
        const floor = ctx.chat.length - 1;
        if (floor < 0) return { changed: false, stateId: marker.baseStateId };
        const tail = copies[floor]; selectedCandidate(tail);
        const parentId = stateFromIndex({ ...ctx, chat: copies }, floor - 1, marker, index);
        const state = currentState(ctx), stateId = await graph.save(encodeState(state), { parentId });
        index.messages[tail[STORY_MESSAGE_ID]].candidates[candidateId(tail)].stateId = stateId;
        const indexId = await graph.save(index, { parentId: marker.indexId });
        const now = assertCurrent(getContext, token);
        if (JSON.stringify(currentState(now)) !== JSON.stringify(state)) throw failure('STORY_STATE_CHANGED', '保存期间剧情变量已变化，请重试。');
        if (indexId === marker.indexId) return completedCapture(now, state, { changed: false, stateId }, saveReceipt);
        commitIdentities(now.chat, copies);
        now.chatMetadata[STORY_STORAGE_KEY] = { ...marker, indexId };
        return completedCapture(now, state, { changed: true, stateId }, saveReceipt);
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

    async function capture({ expectedReference, saveReceipt = false } = {}) {
        return locked(async () => {
            requireAvailable();
            const ctx = current(), marker = assertMarker(ctx);
            if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
            if (marker.indexId) return captureIndexed(ctx, marker, saveReceipt);
            const floor = ctx.chat.length - 1;
            if (floor < 0) return { changed: false, stateId: marker.baseStateId };
            const parentStateId = refsTo(ctx, floor - 1, marker);
            // Existing mismatched refs mean this floor was edited or another
            // candidate selected. A new candidate may have no ref yet.
            let old;
            try { old = getReference(ctx.chat[floor], { parentStateId }); }
            catch(error){
                if(error.code!=='STALE_REFERENCE'||!expectedReference)throw error;
                old=getReference(ctx.chat[floor],{parentStateId,allowStale:true});
                if(JSON.stringify(old)!==JSON.stringify(expectedReference))throw error;
            }
            const token = contextToken(ctx), state = currentState(ctx);
            const stateId = await graph.save(encodeState(state), { parentId: parentStateId });
            const now = assertCurrent(getContext, token);
            if (JSON.stringify(currentState(now)) !== JSON.stringify(state))
                throw failure('STORY_STATE_CHANGED', '保存期间剧情变量已变化，请重试。');
            if (old?.stateId === stateId && old.revision === chatRevisions([now.chat[floor]])[0])
                return completedCapture(now, state, { changed: false, stateId }, saveReceipt);
            setReference(now.chat[floor], stateId, { parentStateId });
            return completedCapture(now, state, { changed: true, stateId }, saveReceipt);
        });
    }

    async function readFloor(index) {
        requireAvailable();
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx);
        const stateId = marker.indexId ? stateFromIndex(ctx, index, marker, await loadIndex(marker)) : refsTo(ctx, index, marker);
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
        if (!linked && marker.indexId) linked = (await allLinkedIds(ctx, marker)).has(stateId) && stateId !== marker.indexId;
        if (!linked && !marker.indexId) {
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

    // Explicit repair only: inspect saved states without treating stale text as
    // permission to replace them with the latest chat's variables.
    async function visitStates(ids, visitor, options = {}) {
        if (typeof graph.visitMany === 'function') return graph.visitMany(ids, visitor, options);
        // Custom adapters from older hosts keep their existing load contract.
        for (const id of new Set(ids)) {
            let state, error = null;
            try { state = await graph.load(id); }
            catch (cause) { if (!options.settled) throw cause; error = cause; }
            await visitor(state, id, error);
        }
    }
    async function inspectReferences() {
        requireAvailable();
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx), repairs = [];
        if (marker.indexId) {
            const index = await loadIndex(marker);
            await visitStates(indexStateIds(buildIndex(ctx.chat, chatIdentity(ctx), index, marker.indexId).index), state => { decodeState(state); });
            stateFromIndex(ctx, ctx.chat.length - 1, marker, index);
            assertCurrent(getContext, token);
            return { repairs, token };
        }
        let parentStateId = marker.baseStateId;
        for (let index = 0; index < ctx.chat.length; index++) {
            const message = ctx.chat[index];
            let reference;
            try { reference = getReference(message, { parentStateId }); }
            catch (error) {
                if (error.code !== 'STALE_REFERENCE') throw error;
                reference = getReference(message, { parentStateId, allowStale: true });
                const snapshot = decodeState(await graph.load(reference.stateId));
                repairs.push({ index, stateId: reference.stateId, revision: reference.revision,
                    currentRevision: chatRevisions([message])[0], parentStateId,
                    roots: Object.keys(snapshot.variables) });
            }
            if (!reference && !(message.is_user || message.is_system)) throw failure('STORY_REFERENCE_MISSING', `第 ${index + 1} 楼缺少剧情引用，不能仅修复校验。`);
            if (reference) parentStateId = reference.stateId;
        }
        // Verify the resulting branch state exists even if only ancestors need repair.
        await graph.load(parentStateId);
        assertCurrent(getContext, token);
        return { repairs, token };
    }
    async function repairReferences(plan) {
        return locked(async () => {
            if (!plan?.token || !Array.isArray(plan.repairs)) throw failure('STORY_REPAIR_PLAN', '请先检查剧情存档引用。');
            assertCurrent(getContext, plan.token);
            const checked = await inspectReferences();
            if (JSON.stringify(checked.repairs) !== JSON.stringify(plan.repairs)) throw failure('STORY_REPAIR_CHANGED', '引用已变化，请重新检查。');
            const ctx = assertCurrent(getContext, plan.token);
            const previous = checked.repairs.map(row => {
                const message=ctx.chat[row.index],slot=message.swipe_info?.[message.swipe_id??0]?.extra;
                return {message, top:clone(message.extra?.[STORY_REFERENCE_KEY]??null),slot, candidate:clone(slot?.[STORY_REFERENCE_KEY]??null)};
            });
            for (const row of checked.repairs) setReference(ctx.chat[row.index], row.stateId, { parentStateId: row.parentStateId });
            const after=contextToken(ctx);
            const rollback=()=>{
                assertCurrent(getContext,after);
                for(const item of previous){
                    if(item.top===null)delete item.message.extra[STORY_REFERENCE_KEY];else item.message.extra[STORY_REFERENCE_KEY]=item.top;
                    if(item.slot){if(item.candidate===null)delete item.slot[STORY_REFERENCE_KEY];else item.slot[STORY_REFERENCE_KEY]=item.candidate;}
                }
            };
            return { changed: checked.repairs.length > 0, repaired: checked.repairs.length, rollback };
        });
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
        const token = contextToken(ctx), ids = await allLinkedIds(ctx, marker);
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
        const required = marker ? marker.indexId ? [marker.baseStateId, marker.indexId, ...(marker.backups ?? []).map(b => b.stateId)] : [...linkedIds(ctx, marker)] : [];
        if (required.some(id => !bundle.graph.roots.includes(id)))
            throw failure('STORY_IMPORT_INCOMPLETE', '剧情数据包缺少当前聊天引用的楼层或备份状态。');
        await graph.importClosure(bundle.graph);
        assertCurrent(getContext, token);
        return { imported: true, roots: bundle.graph.roots.length };
    }

    // Inspection is explicit and read-only: never migrates identities, restores
    // variables, or changes a shared branch snapshot.
    async function inspectIndex() {
        requireAvailable();
        const ctx = current(), marker = assertMarker(ctx);
        if (!marker) throw failure('STORY_NOT_ENABLED', '当前聊天尚未启用外置剧情存储。');
        const token = contextToken(ctx), saved = await loadIndex(marker);
        const index = buildIndex(ctx.chat, chatIdentity(ctx), saved, marker.indexId).index;
        const health = new Map();
        await visitStates([marker.baseStateId, ...indexStateIds(index), ...(marker.backups ?? []).map(backup => backup.stateId)], (state, id, error) => {
            try {
                if (error) throw error;
                decodeState(state); health.set(id, { readable: true });
            } catch (error) { health.set(id, { readable: false, error: error.message }); }
        }, { settled: true });
        const rows = [];
        for (const [floor, messageId] of Object.entries(index.order)) {
            const row = index.messages[messageId], message = ctx.chat[Number(floor)];
            // Canonical storage orders keys by ID; the UI follows Swipe order.
            for (const [candidateId, candidate] of Object.entries(row.candidates).sort((a, b) => a[1].swipe - b[1].swipe)) rows.push({
                floor: Number(floor), messageId, candidateId, swipe: candidate.swipe,
                selected: candidate.swipe === row.selected,
                role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant',
                stateId: candidate.stateId,
                ...(candidate.stateId ? health.get(candidate.stateId) : { readable: null }),
            });
        }
        let storage = null, storageError = null;
        try {
            const indices = marker.indexId ? await graph.exportClosure([marker.indexId]) : { nodes: {} };
            const states = await graph.exportClosure([...health.keys()]);
            const bytes = node => new TextEncoder().encode(JSON.stringify(node)).length;
            const indexBytes = Object.values(indices.nodes).reduce((sum, node) => sum + bytes(node), 0);
            const stateBytes = Object.entries(states.nodes).reduce((sum, [id, node]) => sum + (own(indices.nodes, id) ? 0 : bytes(node)), 0);
            storage = { indexBytes, stateBytes, totalBytes: indexBytes + stateBytes,
                records: new Set([...Object.keys(indices.nodes), ...Object.keys(states.nodes)]).size };
        } catch (error) { storageError = error.message; }
        assertCurrent(getContext, token);
        return { chat: chatIdentity(ctx), indexed: !!saved, indexId: marker.indexId ?? null,
            inheritedFrom: clone(index.inheritedFrom), baseStateId: marker.baseStateId,
            baseHealth: health.get(marker.baseStateId), rows,
            storage, storageError,
            states: health.size, unreadableStates: [...health.values()].filter(item => !item.readable).length,
            cleanupAvailable: false,
            cleanupReason: '当前检查仅覆盖本聊天及其 Swipe；Amin 尚未实现覆盖全部聊天、分支和备份的引用扫描，因此暂不提供文件清理。' };
    }

    function status() {
        const ctx = getContext();
        try {
            const marker = assertMarker(ctx);
            return {
                enabled: !!marker,
                available: !!available(),
                baseStateId: marker?.baseStateId ?? null,
                indexed: !!marker?.indexId,
                message: marker?.indexId ? '当前聊天按楼层与 Swipe 索引读取外置剧情状态。' : marker ? '当前聊天已使用外置剧情状态。' : '当前聊天尚未启用外置剧情状态。',
            };
        } catch (error) {
            return { enabled: false, available: !!available(), message: error.message, error: error.code ?? 'STORY_STORAGE_ERROR' };
        }
    }

    return { enable, ensureIndex, capture, consumeCaptureReceipt, readFloor, readState, restoreFloor, inspectReferences, repairReferences, restoreBeforeCandidate, exportStory, importStory, inspectIndex, status };
}
