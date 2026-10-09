import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity } from '../shared/operations.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { currentState as legacyCurrentState, encodeState, decodeState as legacyDecodeState } from './story-storage.js';
import { OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS } from './storage.js';

export const CURRENT_STORY_KEY = 'amin_os_current_story_v1';
export const OWNER = 'amin-os/current-story-v1';
export const CURRENT_STORY_FORMAT = 'amin-os-current-story';
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const clone = value => structuredClone(value);
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const OWNED = new Set([...OWNED_VARIABLE_ROOTS, ...Object.values(NATIVE_VARIABLE_ROOTS)]);
export function currentStoryRuleRoot(path) {
    const text = String(path ?? '').replace(/^\.+/u, '');
    if (text[0] !== '[') return text.split(/[.\[]/u, 1)[0].trim();
    const match = /^\[(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/u.exec(text);
    return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
export function currentStoryState(ctx) {
    const state = legacyCurrentState(ctx);
    state.rules = {};
    for (const [path, rule] of Object.entries(ctx.chatMetadata.LWB_RULES_V2 ?? {})) {
        if (OWNED.has(currentStoryRuleRoot(path))) {
            if (!plain(rule)) fail('STORY_CURRENT_INVALID', '当前状态规则必须是有效对象。');
            state.rules[path] = clone(rule);
        }
    }
    return state;
}
const currentState = currentStoryState;
function decodeState(record) {
    if (!plain(record) || !plain(record.rules) || Object.entries(record.rules).some(([path, rule]) =>
        !OWNED.has(currentStoryRuleRoot(path)) || !plain(rule)))
        fail('STORY_CURRENT_CORRUPT', '当前状态规则结构无效。');
    const decoded = legacyDecodeState({ ...record, rules: {} });
    return { ...decoded, rules: clone(record.rules) };
}
function fail(code, message) { const error = Error(message); error.code = code; throw error; }
function canonical(value, stack = new Set(), depth = 0) {
    if (depth > 80) fail('STORY_CURRENT_INVALID', '当前状态嵌套过深。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || stack.has(value))
        fail('STORY_CURRENT_INVALID', '当前状态必须是有效 JSON 数据。');
    stack.add(value);
    let result;
    if (Array.isArray(value)) {
        result = Array.from({ length: value.length }, (_, index) => {
            if (!own(value, index)) fail('STORY_CURRENT_INVALID', '当前状态数组不能包含空位。');
            return canonical(value[index], stack, depth + 1);
        });
    } else {
        result = {};
        for (const key of Object.keys(value).sort()) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('STORY_CURRENT_INVALID', '当前状态包含受保护的字段。');
            result[key] = canonical(value[key], stack, depth + 1);
        }
    }
    stack.delete(value);
    return result;
}
const serialized = value => JSON.stringify(canonical(value));
const digest = value => 'sha256:' + sha256HexSync(serialized(value));
export const currentStoryKey = identity => 'current-' + sha256HexSync(identity);
function seal(record) {
    const { hash: ignored, ...data } = record;
    return canonical({ ...data, hash: digest(data) });
}
function entry(state, label = '当前状态') {
    const encoded = canonical(encodeState(state));
    decodeState(encoded);
    return { state: encoded, hash: digest(encoded), at: Date.now(), label };
}
export function validateCurrentStoryRecord(value) {
    const record = canonical(value);
    if (!plain(record) || record.version !== 1 || record.owner !== OWNER || typeof record.chat !== 'string'
        || !record.chat || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !Array.isArray(record.backups) || record.backups.length > 5 || !HASH.test(record.hash ?? '')
        || Object.keys(record).sort().join(',') !== 'backups,chat,current,hash,owner,revision,version')
        fail('STORY_CURRENT_CORRUPT', '当前状态记录格式无效，原资料未改写。');
    for (const item of [record.current, ...record.backups]) {
        if (!plain(item) || Object.keys(item).sort().join(',') !== 'at,hash,label,state'
            || !HASH.test(item.hash ?? '') || !Number.isFinite(item.at) || item.at < 0
            || typeof item.label !== 'string' || item.label.length > 160)
            fail('STORY_CURRENT_CORRUPT', '当前状态或备份条目格式无效。');
        decodeState(item.state);
        if (digest(item.state) !== item.hash) fail('STORY_CURRENT_CORRUPT', '当前状态或备份校验不一致，已停止读取。');
    }
    const { hash, ...data } = record;
    if (digest(data) !== hash) fail('STORY_CURRENT_CORRUPT', '当前状态记录校验不一致，已停止读取。');
    if (new TextEncoder().encode(serialized(record)).length > MAX_BYTES)
        fail('STORY_CURRENT_TOO_LARGE', '当前状态与最近备份超过单个文件大小限制。');
    return record;
}
function marker(ctx) {
    const value = ctx?.chatMetadata?.[CURRENT_STORY_KEY];
    if (value === undefined) return null;
    if (!plain(value) || value.version !== 1 || value.owner !== OWNER || typeof value.chat !== 'string'
        || value.key !== currentStoryKey(value.chat)
        || Object.keys(value).sort().join(',') !== 'chat,key,owner,version')
        fail('STORY_CURRENT_MARKER', '当前状态模式标记无效，原资料未改写。');
    return value;
}
const makeMarker = identity => ({ version: 1, owner: OWNER, key: currentStoryKey(identity), chat: identity });
const bodies = ctx => JSON.stringify(ctx.chat.map(message => [message?.name, message?.is_user, message?.is_system,
    message?.mes, message?.swipe_id, message?.swipes]));
const defaultRestore = async (_floor, snapshot, options) => {
    const { applyCurrentStoryState } = await import('./current-native-bridge.js');
    return applyCurrentStoryState(snapshot, options);
};

/** One mutable record per chat; no historical floor or candidate identities. */
export function createCurrentStoryStorage(getContext, { files, restoreState = defaultRestore, host = globalThis, document = globalThis.document } = {}) {
    if (typeof getContext !== 'function' || typeof files?.get !== 'function' || typeof files?.put !== 'function')
        throw TypeError('当前状态存储需要聊天上下文与可覆盖文件存储。');
    let busy = false;
    const receipts = new WeakMap(), backupCounts = new Map();
    const available = () => typeof files.available !== 'function' || files.available();
    function current() {
        const ctx = getContext(); assertChatReady(ctx);
        if (!plain(ctx?.chatMetadata) || !Array.isArray(ctx.chat) || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null)
            fail('STORY_CURRENT_NO_CHAT', '请先打开已经加载完成的聊天。');
        return ctx;
    }
    function token(ctx) {
        return { metadata: ctx.chatMetadata, integrity: ctx.chatMetadata.integrity,
            identity: chatIdentity(ctx), bodies: bodies(ctx), marker: JSON.stringify(ctx.chatMetadata[CURRENT_STORY_KEY]) };
    }
    function check(saved) {
        const ctx = current();
        if (ctx.chatMetadata !== saved.metadata || ctx.chatMetadata.integrity !== saved.integrity
            || chatIdentity(ctx) !== saved.identity || bodies(ctx) !== saved.bodies
            || JSON.stringify(ctx.chatMetadata[CURRENT_STORY_KEY]) !== saved.marker)
            fail('STORY_CURRENT_CHAT_CHANGED', '聊天或候选已变化，当前状态操作未关联到新聊天。');
        return ctx;
    }
    async function locked(work) {
        if (busy) fail('STORY_CURRENT_BUSY', '当前状态正在保存，请稍后。');
        if (!available()) fail('STORY_CURRENT_UNAVAILABLE', '当前状态文件存储不可用。');
        busy = true; try { return await work(); } finally { busy = false; }
    }
    async function get(key, identity) {
        const value = await files.get(key);
        if (value === null) return null;
        const record = validateCurrentStoryRecord(value);
        if (record.chat !== identity) fail('STORY_CURRENT_CHAT_MISMATCH', '当前状态记录属于其他聊天。');
        backupCounts.set(key, record.backups.length);
        return record;
    }
    async function put(key, value, previous) {
        const record = validateCurrentStoryRecord(value);
        await files.put(key, clone(record), { expected: clone(previous) });
        backupCounts.set(key, record.backups.length);
        return record;
    }
    function record(identity, state, previous = null, label = '当前状态') {
        const next = entry(state, label);
        return seal({ version: 1, owner: OWNER, chat: identity, revision: (previous?.revision ?? 0) + 1,
            current: next, backups: previous ? (next.hash === previous.current.hash ? clone(previous.backups)
                : [clone(previous.current), ...clone(previous.backups)].slice(0, 5)) : [] });
    }
    async function bound(ctx, saved) {
        const source = marker(ctx);
        if (!source) fail('STORY_CURRENT_DISABLED', '当前聊天尚未启用仅当前状态模式。');
        const identity = chatIdentity(ctx);
        if (source.chat === identity) {
            const existing = await get(source.key, identity); check(saved);
            if (!existing) fail('STORY_CURRENT_MISSING', '找不到当前状态文件，请导入对应的当前状态备份。');
            return { record: existing, marker: source, changed: false };
        }
        const parent = await get(source.key, source.chat); check(saved);
        if (!parent) fail('STORY_CURRENT_MISSING', '找不到继承的当前状态文件。');
        const destination = makeMarker(identity), existing = await get(destination.key, identity); check(saved);
        const copied = existing ?? seal({ ...clone(parent), chat: identity, revision: 1 });
        if (!existing) await put(destination.key, copied, null);
        check(saved);
        ctx.chatMetadata[CURRENT_STORY_KEY] = destination;
        return { record: copied, marker: destination, changed: true };
    }
    function receipt(ctx, state, result, enabled) {
        if (!enabled) return result;
        const value = Object.freeze({}); receipts.set(value, { token: token(ctx), state: digest(encodeState(state)) });
        return { ...result, receipt: value };
    }
    function transaction(ctx, key, written, previous, undoMarker = null, saved = token(ctx)) {
        const verify = async () => {
            check(saved);
            const stored = await get(key, written.chat); check(saved);
            if (!stored || stored.hash !== written.hash || stored.revision !== written.revision)
                fail('STORY_CURRENT_CONFLICT', '当前状态文件已变化，请重新操作。');
        };
        return { changed: true, key, currentHash: written.current.hash, stateId: written.current.hash,
            snapshot: decodeState(written.current.state), check: () => { check(saved); }, verify,
            async rollback() {
                await verify();
                if (undoMarker) undoMarker();
                else if (previous) { await files.put(key, clone(previous), { expected: clone(written) }); backupCounts.set(key, previous.backups.length); }
            } };
    }
    async function switchToCurrent({ clear = false } = {}) {
        return locked(async () => {
            const ctx = current(), saved = token(ctx), identity = chatIdentity(ctx), target = makeMarker(identity);
            const state = currentState(ctx), stateHash = digest(encodeState(state));
            const existing = await get(target.key, identity); check(saved);
            let next = record(identity, state, existing, '切换为仅当前状态');
            if (existing?.current.hash === stateHash) next = existing;
            if (clear) next = record(identity, { variables: {}, rules: {} }, next, '清空当前状态');
            if (next !== existing) await put(target.key, next, existing);
            check(saved);
            if (digest(encodeState(currentState(ctx))) !== stateHash)
                fail('STORY_CURRENT_STATE_CHANGED', '切换模式期间当前变量已变化，请重试。');
            const hadMarker = own(ctx.chatMetadata, CURRENT_STORY_KEY), beforeMarker = clone(ctx.chatMetadata[CURRENT_STORY_KEY]);
            ctx.chatMetadata[CURRENT_STORY_KEY] = target;
            const tx = transaction(ctx, target.key, next, existing, () => {
                if (hadMarker) ctx.chatMetadata[CURRENT_STORY_KEY] = beforeMarker; else delete ctx.chatMetadata[CURRENT_STORY_KEY];
            });
            return { ...tx, enabled: true, currentOnly: true, message: clear
                ? '已保留清空前备份并启用仅当前状态模式。' : '已启用仅当前状态模式；历史文件与聊天正文仍保留。' };
        });
    }
    async function ensureIndex() {
        return locked(async () => {
            const ctx = current(), saved = token(ctx), result = await bound(ctx, saved);
            return { changed: result.changed, key: result.marker.key, currentOnly: true, indexed: false };
        });
    }
    async function capture({ saveReceipt = false } = {}) {
        return locked(async () => {
            const ctx = current(), saved = token(ctx), result = await bound(ctx, saved), afterBinding = token(ctx);
            const state = currentState(ctx), stateHash = digest(encodeState(state));
            let next = result.record, changed = result.changed;
            if (stateHash !== next.current.hash) {
                next = await put(result.marker.key, record(next.chat, state, next, '自动保存当前状态'), next);
                changed = true;
            }
            check(afterBinding);
            if (digest(encodeState(currentState(ctx))) !== stateHash)
                fail('STORY_CURRENT_STATE_CHANGED', '保存期间当前变量已变化，请重试。');
            return receipt(ctx, state, { changed, stateId: next.current.hash, currentHash: next.current.hash,
                snapshot: decodeState(next.current.state) }, saveReceipt);
        });
    }
    function consumeCaptureReceipt(value, ctx) {
        const saved = value && receipts.get(value);
        if (!saved) return null;
        receipts.delete(value);
        check(saved.token);
        if (ctx?.chatMetadata !== saved.token.metadata || chatIdentity(ctx) !== saved.token.identity)
            fail('STORY_CURRENT_CHAT_CHANGED', '保存准备期间聊天已切换。');
        if (digest(encodeState(currentState(ctx))) !== saved.state) return null;
        return () => {
            const now = check(saved.token);
            if (digest(encodeState(currentState(now))) !== saved.state)
                fail('STORY_CURRENT_STATE_CHANGED', '保存准备期间当前变量已变化，请重试。');
        };
    }
    async function read() {
        if (!available()) fail('STORY_CURRENT_UNAVAILABLE', '当前状态文件存储不可用。');
        const ctx = current(), saved = token(ctx), source = marker(ctx);
        if (!source || source.chat !== chatIdentity(ctx)) fail('STORY_CURRENT_DISABLED', '请先为当前聊天关联独立的当前状态记录。');
        const value = await get(source.key, source.chat); check(saved);
        if (!value) fail('STORY_CURRENT_MISSING', '找不到当前状态文件，请导入对应备份。');
        return { ctx, saved, record: value, marker: source };
    }
    async function readFloor(floor) {
        const result = await read();
        if (floor !== result.ctx.chat.length - 1) fail('STORY_CURRENT_NO_HISTORY', '仅当前状态模式不提供旧楼层或 Swipe 历史。');
        return { ...decodeState(result.record.current.state), stateId: result.record.current.hash, floor, currentOnly: true };
    }
    async function readState(hash) {
        if (!HASH.test(hash ?? '')) fail('STORY_CURRENT_STATE_INVALID', '当前状态备份编号无效。');
        const result = await read(), item = [result.record.current, ...result.record.backups].find(entry => entry.hash === hash);
        if (!item) fail('STORY_CURRENT_STATE_UNLINKED', '该备份不属于当前聊天的最近备份。');
        return { ...decodeState(item.state), stateId: item.hash, currentOnly: true };
    }
    async function restoreFloor(floor) {
        const result = await readFloor(floor), ctx = current(), saved = token(ctx);
        const restored = await restoreState(floor, { variables: result.variables, rules: result.rules },
            { context: getContext, host, document, isCurrent: () => { try { check(saved); return true; } catch { return false; } } });
        check(saved);
        return { ...restored, stateId: result.stateId, currentOnly: true };
    }
    async function restoreBeforeCandidate() { current(); return { restored: true, stale: false, currentOnly: true, noRewind: true }; }
    async function update(kind, index, { expectedHash } = {}) {
        return locked(async () => {
            let result;
            try { result = await read(); }
            catch (error) {
                if (['STORY_CURRENT_CORRUPT', 'STORY_STATE_CORRUPT', 'STORY_CURRENT_INVALID'].includes(error.code))
                    error.message += '；请先导入本聊天的有效当前状态备份，再重试。';
                throw error;
            }
            const previous = result.record;
            let snapshot;
            if (kind === 'clear') snapshot = { variables: {}, rules: {} };
            else {
                if (!Number.isSafeInteger(index) || index < 0 || index >= previous.backups.length)
                    fail('STORY_CURRENT_BACKUP_INVALID', '所选备份不存在，请刷新列表。');
                if (expectedHash !== undefined && previous.backups[index].hash !== expectedHash)
                    fail('STORY_CURRENT_BACKUP_CHANGED', '备份列表已变化，请刷新后重新选择。');
                snapshot = decodeState(previous.backups[index].state);
            }
            const live = entry(currentState(result.ctx), '操作前当前状态');
            const prior = live.hash === previous.current.hash ? previous : {
                ...previous, current: live, backups: [clone(previous.current), ...clone(previous.backups)].slice(0, 5),
            };
            if (kind === 'clear' && digest(encodeState(snapshot)) === previous.current.hash && live.hash === previous.current.hash)
                return { changed: false, snapshot, stateId: previous.current.hash, check: () => { check(result.saved); },
                    verify: async () => { check(result.saved); }, rollback: async () => {}, message: '当前状态已经为空。' };
            const next = record(previous.chat, snapshot, prior, kind === 'clear' ? '清空当前状态' : '恢复最近备份');
            await put(result.marker.key, next, previous);
            const tx = transaction(result.ctx, result.marker.key, next, previous, null, result.saved);
            try {
                check(result.saved);
                if (digest(encodeState(currentState(result.ctx))) !== live.hash)
                    fail('STORY_CURRENT_STATE_CHANGED', '操作期间当前变量已变化，请重试。');
            } catch (error) {
                try { await tx.rollback(); }
                catch (rollbackError) { error.message += '；文件回滚未执行：' + rollbackError.message; }
                throw error;
            }
            return { ...tx, message: kind === 'clear'
                ? '已保留清空前状态为最近备份。' : '所选备份已写为当前状态；恢复前状态已保留。' };
        });
    }
    async function inspectCurrentBackups() {
        const result = await read();
        return { currentHash: result.record.current.hash, backups: result.record.backups.map((item, index) =>
            ({ index, at: item.at, label: item.label, hash: item.hash })) };
    }
    async function exportStory() { const result = await read(); return { format: CURRENT_STORY_FORMAT, version: 1, record: clone(result.record) }; }
    async function importStory(bundle) {
        return locked(async () => {
            if (!plain(bundle) || bundle.format !== CURRENT_STORY_FORMAT || bundle.version !== 1)
                fail('STORY_CURRENT_IMPORT_INVALID', '该文件不是仅当前状态模式的备份。');
            const imported = validateCurrentStoryRecord(bundle.record), ctx = current(), saved = token(ctx), identity = chatIdentity(ctx);
            if (imported.chat !== identity) fail('STORY_CURRENT_CHAT_MISMATCH', '该当前状态备份属于另一条聊天。');
            const key = currentStoryKey(identity);
            let previous;
            try { previous = await files.get(key); }
            catch (error) { error.message = '当前状态文件无法读取或解析，未覆盖；' + error.message; throw error; }
            check(saved);
            // A verified backup may replace this chat's damaged record, but never
            // silently treat unreadable or foreign data as a missing file.
            if (previous !== null && (!plain(previous) || previous.owner !== OWNER || previous.chat !== identity))
                fail('STORY_CURRENT_IMPORT_UNSAFE_EXISTING', '当前文件无法确认属于本聊天，未覆盖；请先保留原文件并核查归属。');
            const priorRevision = Number.isSafeInteger(previous?.revision) && previous.revision >= 1
                && previous.revision < Number.MAX_SAFE_INTEGER ? previous.revision : 0;
            const next = seal({ ...clone(imported), revision: priorRevision + 1 });
            await put(key, next, previous); check(saved);
            return { ...transaction(ctx, key, next, previous), imported: true, currentOnly: true, backups: next.backups.length,
                message: '当前状态备份已校验并导入；当前变量未自动恢复。' };
        });
    }
    async function inspectStorage() {
        const result = await read();
        return { currentOnly: true, bytes: new TextEncoder().encode(serialized(result.record)).length, records: 1,
            checkpointCount: 1, deltaCount: 0, backups: result.record.backups.length,
            referenceBytes: new TextEncoder().encode(JSON.stringify(result.marker)).length };
    }
    async function inspectIndex() {
        const result = await read();
        return { currentOnly: true, indexed: false, rows: [], states: 1 + result.record.backups.length,
            unreadableStates: 0, baseHealth: { readable: true }, inheritedFrom: null,
            cleanupAvailable: false, cleanupReason: '仅保留当前状态与最近 5 份备份，不提供旧楼层或 Swipe 历史。' };
    }
    function status() {
        try { const source = marker(getContext()); return { mode: 'current-only', currentOnly: true, enabled: !!source,
            available: !!available(), indexed: false, key: source?.key ?? null, backupCount: source ? backupCounts.get(source.key) ?? null : 0, message: source
                ? '当前聊天使用仅当前状态与最近 5 份备份。' : '当前聊天尚未启用仅当前状态模式。' }; }
        catch (error) { return { mode: 'current-only', currentOnly: true, enabled: false, available: !!available(), message: error.message, error: error.code }; }
    }
    return { status, isCurrent: (ctx = getContext()) => !!marker(ctx), enable: () => switchToCurrent(), switchToCurrent,
        ensureIndex, capture, consumeCaptureReceipt, readFloor, readState, restoreFloor, restoreBeforeCandidate,
        clearCurrent: () => update('clear'), restoreCurrentBackup: (index, options) => update('restore', index, options),
        inspectCurrentBackups, inspectStorage, inspectIndex, exportStory, importStory };
}
