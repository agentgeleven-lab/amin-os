import { assertChatReady } from '../shared/chat-lifecycle.js';
import { chatIdentity } from '../shared/operations.js';
import { sha256HexSync } from '../tts/source-hash.js';
import { validateJSON } from '../saves/model.js';
import { KEY, validateState, stateHash, canonicalJSON } from './schema.js';

export const BACKUP_NAMESPACE = 'amin-os';
export const BACKUP_TABLE = 'amin-state-backups-v1';
export const BACKUP_OWNER = 'amin-os/independent-backups-v1';
export const BACKUP_FORMAT = 'amin-os-independent-backups';
export const LEGACY_TABLE = 'amin-state-legacy-source-v1';
export const LEGACY_OWNER = 'amin-os/legacy-source-v1';
export const LEGACY_FORMAT = 'amin-os-legacy-source';
const MAX_BYTES = 192 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const locks = new WeakMap();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const clone = value => structuredClone(value);
export const backupKey = identity => 'backups-' + sha256HexSync(identity);
export const legacySourceKey = identity => 'legacy-' + sha256HexSync(identity);
const recordHash = value => 'sha256:' + sha256HexSync(canonicalJSON(value));
const seal = value => ({ ...value, hash: recordHash(value) });
export function validateLegacySource(input, identity) {
    validateJSON(input, MAX_BYTES);
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'at,chat,hash,owner,sources,version'
        || input.version !== 1 || input.owner !== LEGACY_OWNER || input.chat !== identity || !plain(input.sources)
        || typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at)) || !HASH.test(input.hash ?? ''))
        fail('AMIN_LEGACY_SOURCE_INVALID', '原始旧资料归档格式或归属无效，未覆盖。');
    const { hash, ...data } = input;
    if (recordHash(data) !== hash) fail('AMIN_LEGACY_SOURCE_CORRUPT', '原始旧资料归档校验不一致，未覆盖。');
    return clone(input);
}

export function validateBackupRecord(input, identity) {
    validateJSON(input, MAX_BYTES);
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'chat,entries,hash,owner,version'
        || input.version !== 1 || input.owner !== BACKUP_OWNER || input.chat !== identity
        || !Array.isArray(input.entries) || input.entries.length > 5 || !HASH.test(input.hash ?? ''))
        fail('AMIN_BACKUP_INVALID', 'Amin 最近备份格式、归属或数量无效，原文件未改写。');
    const ids = new Set();
    for (const entry of input.entries) {
        if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'at,hash,id,label,state'
            || typeof entry.id !== 'string' || !/^r[0-9]+-[a-f0-9]{64}$/u.test(entry.id)
            || ids.has(entry.id) || !HASH.test(entry.hash ?? '') || typeof entry.at !== 'string'
            || !Number.isFinite(Date.parse(entry.at)) || typeof entry.label !== 'string' || entry.label.length > 160)
            fail('AMIN_BACKUP_INVALID', 'Amin 最近备份条目无效或重复。');
        const state = validateState(entry.state), hash = stateHash(state);
        if (hash !== entry.hash || entry.id !== `r${state.revision}-${hash.slice(7)}`)
            fail('AMIN_BACKUP_CORRUPT', 'Amin 备份状态校验不一致，已停止读取。');
        ids.add(entry.id);
    }
    const { hash, ...data } = input;
    if (recordHash(data) !== hash) fail('AMIN_BACKUP_CORRUPT', 'Amin 备份文件校验不一致，已停止读取。');
    return clone(input);
}

/** Separate backup table; expected/readback checks are not cross-device CAS. */
export function createIndependentBackupFileStore({ getHostWindow = () => globalThis.window } = {}) {
    const api = () => {
        const host = getHostWindow(), store = host?.__TAURITAVERN__?.api?.extension?.store;
        return typeof store?.tryGetJson === 'function' && typeof store?.setJson === 'function' ? store : null;
    };
    async function requireApi() {
        const host = getHostWindow(), ready = host?.__TAURITAVERN__?.ready ?? host?.__TAURITAVERN_MAIN_READY__;
        if (ready && typeof ready.then === 'function') await ready;
        const store = api();
        if (!store) fail('AMIN_BACKUP_UNAVAILABLE', '外部备份存储不可用；当前 Amin 状态仍随聊天保存。');
        return store;
    }
    async function read(store, key, table = BACKUP_TABLE) {
        const result = await store.tryGetJson({ namespace: BACKUP_NAMESPACE, table, key });
        const found = plain(result) && Object.getOwnPropertyDescriptor(result, 'found');
        if (!found || !Object.hasOwn(found, 'value') || typeof found.value !== 'boolean')
            fail('AMIN_BACKUP_RESPONSE_INVALID', '外部备份存储读取结果无效。');
        if (!found.value) return null;
        const value = Object.getOwnPropertyDescriptor(result, 'value');
        if (!value || !Object.hasOwn(value, 'value')) fail('AMIN_BACKUP_RESPONSE_INVALID', '外部备份存储没有返回有效记录。');
        validateJSON(value.value, MAX_BYTES);
        if (!plain(value.value)) fail('AMIN_BACKUP_INVALID', '外部备份记录无法解析，未覆盖。');
        return clone(value.value);
    }
    function checkedKey(key, legacy = false) {
        if (typeof key !== 'string' || !(legacy ? /^legacy-[a-f0-9]{64}$/u : /^backups-[a-f0-9]{64}$/u).test(key))
            fail('AMIN_BACKUP_KEY_INVALID', '备份文件标识无效。');
        return key;
    }
    async function write(table, key, value, { expected } = {}) {
            checkedKey(key, table === LEGACY_TABLE); validateJSON(value, MAX_BYTES);
            if (!plain(value) || expected === undefined) fail('AMIN_BACKUP_EXPECTED_REQUIRED', '写入备份必须提供完整预期旧记录或 null。');
            if (table === LEGACY_TABLE && expected !== null) fail('AMIN_LEGACY_IMMUTABLE', '原始旧资料只能归档一次，不能覆盖。');
            if (expected !== null) validateJSON(expected, MAX_BYTES);
            const snapshot = clone(value), old = clone(expected), store = await requireApi();
            let pending = locks.get(store); if (!pending) locks.set(store, pending = new Set());
            if (pending.has(key)) fail('AMIN_BACKUP_CONFLICT', '备份文件正在写入，请稍后重试。');
            pending.add(key);
            try {
                const previous = await read(store, key, table);
                if (canonicalJSON(previous) !== canonicalJSON(old)) fail('AMIN_BACKUP_CONFLICT', '备份文件已变化，请重新读取。');
                await store.setJson({ namespace: BACKUP_NAMESPACE, table, key, value: snapshot });
                if (canonicalJSON(await read(store, key, table)) !== canonicalJSON(snapshot))
                    fail('AMIN_BACKUP_WRITE_VERIFY_FAILED', '备份写入后回读校验失败。');
            } finally { pending.delete(key); }
    }
    return {
        available() { try { return !!api(); } catch { return false; } },
        async get(key) { return read(await requireApi(), checkedKey(key)); },
        put: (key, value, options) => write(BACKUP_TABLE, key, value, options),
        async getLegacy(key) { return read(await requireApi(), checkedKey(key, true), LEGACY_TABLE); },
        putLegacy: (key, value, options) => write(LEGACY_TABLE, key, value, options),
    };
}

export function createIndependentBackups(getContext, { files, getHostWindow, now = () => new Date().toISOString() } = {}) {
    if (typeof getContext !== 'function') throw TypeError('独立备份需要聊天上下文接口。');
    files ??= createIndependentBackupFileStore({ getHostWindow });
    const counts = new Map(); let busy = false;
    const available = () => { try { return typeof files?.get === 'function' && typeof files?.put === 'function'
        && (typeof files.available !== 'function' || files.available()); } catch { return false; } };
    function context(ctx = getContext()) {
        assertChatReady(ctx);
        if (!plain(ctx?.chatMetadata) || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null)
            fail('AMIN_BACKUP_NO_CHAT', '请先打开已经加载完成的聊天。');
        return ctx;
    }
    function token(ctx) { return { metadata: ctx.chatMetadata, identity: chatIdentity(ctx), integrity: ctx.chatMetadata.integrity,
        state: canonicalJSON(ctx.chatMetadata[KEY] ?? null) }; }
    function check(saved) {
        const ctx = context();
        if (ctx.chatMetadata !== saved.metadata || chatIdentity(ctx) !== saved.identity
            || ctx.chatMetadata.integrity !== saved.integrity || canonicalJSON(ctx.chatMetadata[KEY] ?? null) !== saved.state)
            fail('AMIN_BACKUP_CONTEXT_CHANGED', '聊天或 Amin 当前状态已变化，备份操作已取消。');
    }
    async function read(ctx) {
        const identity = chatIdentity(ctx), raw = await files.get(backupKey(identity));
        const record = raw === null ? null : validateBackupRecord(raw, identity);
        counts.set(identity, record?.entries.length ?? 0); return record;
    }
    async function list(ctx = getContext()) {
        ctx = context(ctx); if (!available()) return [];
        const saved = token(ctx), record = await read(ctx); check(saved);
        return (record?.entries ?? []).map(entry => ({ id: entry.id, at: entry.at, label: entry.label,
            hash: entry.hash, revision: entry.state.revision }));
    }
    async function load(ctx, id) {
        if (id === undefined) { id = ctx; ctx = getContext(); }
        ctx = context(ctx);
        if (!available()) fail('AMIN_BACKUP_UNAVAILABLE', '外部备份存储不可用。');
        const saved = token(ctx), record = await read(ctx); check(saved);
        const entry = record?.entries.find(item => item.id === id);
        if (!entry) fail('AMIN_BACKUP_MISSING', '所选备份不在当前聊天最近 5 份备份中，请刷新列表。');
        return validateState(entry.state);
    }
    async function savePrevious(ctx, input, { label = '操作前状态' } = {}) {
        ctx = context(ctx); const state = validateState(input);
        if (!available()) return { saved: false, disabled: true, message: '外部备份不可用，当前状态仍随聊天保存。' };
        if (busy) fail('AMIN_BACKUP_BUSY', 'Amin 备份正在保存，请稍后。');
        if (typeof label !== 'string' || label.length > 160) fail('AMIN_BACKUP_INVALID', '备份说明无效。');
        busy = true;
        try {
            const saved = token(ctx), identity = saved.identity, previous = await read(ctx); check(saved);
            const hash = stateHash(state), id = `r${state.revision}-${hash.slice(7)}`;
            if (previous?.entries.some(entry => entry.id === id)) return { saved: false, id, hash, duplicate: true };
            const at = now(); if (!Number.isFinite(Date.parse(at))) fail('AMIN_BACKUP_INVALID', '备份时间无效。');
            const next = seal({ version: 1, owner: BACKUP_OWNER, chat: identity,
                entries: [{ id, at, label, state, hash }, ...clone(previous?.entries ?? [])].slice(0, 5) });
            validateBackupRecord(next, identity);
            await files.put(backupKey(identity), next, { expected: clone(previous) }); check(saved);
            counts.set(identity, next.entries.length);
            return { saved: true, id, hash };
        } finally { busy = false; }
    }
    async function exportBackups(ctx = getContext()) {
        ctx = context(ctx); if (!available()) fail('AMIN_BACKUP_UNAVAILABLE', '外部备份存储不可用。');
        const saved = token(ctx), record = await read(ctx); check(saved);
        return { format: BACKUP_FORMAT, version: 1, chat: saved.identity, entries: clone(record?.entries ?? []) };
    }
    const legacyAvailable = () => available() && typeof files.getLegacy === 'function' && typeof files.putLegacy === 'function';
    async function archiveLegacy(ctx, sources) {
        ctx = context(ctx); validateJSON(sources, MAX_BYTES);
        if (!plain(sources)) fail('AMIN_LEGACY_SOURCE_INVALID', '原始旧资料必须是原始根字段对象，未归档。');
        if (!legacyAvailable()) return { archived: false, disabled: true, message: '外部原始归档不可用，请将旧资料保留为聊天内的静态源。' };
        const saved = token(ctx), identity = saved.identity, key = legacySourceKey(identity), snapshot = clone(sources);
        const sourceBasis = () => canonicalJSON(Object.fromEntries(Object.keys(snapshot).map(name => [name,
            [Object.hasOwn(ctx.chatMetadata, name), ctx.chatMetadata[name] ?? null]])));
        const beforeSources = sourceBasis();
        const guard = () => { check(saved); if (sourceBasis() !== beforeSources) fail('AMIN_LEGACY_SOURCE_CHANGED', '待归档旧资料已变化，请重新预览。'); };
        const raw = await files.getLegacy(key); guard();
        if (raw !== null) {
            const existing = validateLegacySource(raw, identity);
            if (canonicalJSON(existing.sources) !== canonicalJSON(snapshot))
                fail('AMIN_LEGACY_SOURCE_EXISTS', '本聊天已有不同的原始旧资料归档，不会覆盖；请先导出并检查。');
            return { archived: false, duplicate: true, key, hash: existing.hash };
        }
        const record = seal({ version: 1, owner: LEGACY_OWNER, chat: identity, at: now(), sources: snapshot });
        validateLegacySource(record, identity);
        await files.putLegacy(key, record, { expected: null }); guard();
        return { archived: true, key, hash: record.hash };
    }
    async function exportLegacy(ctx = getContext()) {
        ctx = context(ctx); if (!legacyAvailable()) fail('AMIN_BACKUP_UNAVAILABLE', '外部原始旧资料归档不可用。');
        const saved = token(ctx), raw = await files.getLegacy(legacySourceKey(saved.identity)); check(saved);
        if (raw === null) return null;
        return { format: LEGACY_FORMAT, version: 1, record: validateLegacySource(raw, saved.identity) };
    }
    function status() {
        try { return { available: !!available(), count: counts.get(chatIdentity(getContext())) ?? 0, limit: 5 }; }
        catch { return { available: false, count: 0, limit: 5 }; }
    }
    return { available, status, list, load, savePrevious, archiveLegacy, exportLegacy, export: exportBackups, exportBackups };
}
