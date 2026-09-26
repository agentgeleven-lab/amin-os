import { createStoryStateGraph } from './story-state-graph.js';
import { validateIndex, indexStateIds } from './story-chat-index.js';
import { sha256Hex } from '../tts/source-hash.js';

const ID = /^sha256:[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
const markerKey = 'amin_os_story_storage_v2';
const referenceKey = 'amin_story_v2';
function abort(signal) {
    if (signal?.aborted) throw Object.assign(new Error('全库检查已取消。'), { name: 'AbortError' });
}
async function pool(items, count, run, signal) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
        while (cursor < items.length) { abort(signal); await run(items[cursor++]); }
    }));
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Read-only, fail-closed census. Completeness is not a global write/sync lock. */
export async function scanStoryLibrary({ census, store, signal, onProgress = () => {}, concurrency = 3,
    maxFiles = 50_000, maxBytes = 256 * 1024 * 1024 } = {}) {
    if (typeof store?.list !== 'function' || typeof store?.get !== 'function') throw new TypeError('需要剧情文件枚举与读取接口。');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError('并发数必须为 1–8。');
    if (![maxFiles, maxBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError('扫描上限无效。');
    abort(signal);
    const issues = [];
    const issue = (code, message, id) => issues.push({ code, message, ...(id ? { id } : {}) });
    let inventory;
    try { inventory = typeof census === 'function' ? await census({ signal, onProgress }) : census; }
    catch (error) { abort(signal); issue('CENSUS_FAILED', '聊天和备份目录读取失败。'); }
    if (!inventory?.complete) issue('CENSUS_INCOMPLETE', '聊天、分支或备份覆盖不完整。');
    if (inventory?.capabilities?.globalDiskCoverage === false) issue('GLOBAL_COVERAGE_UNPROVEN', '宿主尚不能证明全部磁盘聊天和备份已被枚举，不能生成安全清理候选。');
    for (const entry of inventory?.issues ?? []) issue(entry.code ?? 'CENSUS_ISSUE', entry.message ?? '聊天目录存在异常。');
    const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
    if (!Array.isArray(inventory?.entries)) issue('CENSUS_INVALID', '聊天目录格式无效。');
    let listed;
    try { listed = await store.list(); } catch { abort(signal); issue('LIST_FAILED', '外置剧情文件目录读取失败。'); }
    const ids = Array.isArray(listed) ? listed : listed?.ids ?? [];
    if (!Array.isArray(ids)) throw new TypeError('外置文件目录格式无效。');
    if (!Array.isArray(listed) && listed?.complete !== true) issue('LIST_INCOMPLETE', '外置剧情文件目录不完整。');
    if (listed?.unknownKeys?.length) issue('UNKNOWN_FILES', '发现无法识别的外置文件名称，停止生成清理候选。');
    if (new Set(ids).size !== ids.length) issue('DUPLICATE_IDS', '外置文件目录存在重复编号。');
    if (ids.length > maxFiles) issue('FILE_LIMIT', '文件数量超过本次扫描上限。');
    const records = new Map(), files = new Map(), dependencies = new Map();
    let totalBytes = 0, finished = 0, byteLimit = false;
    await pool([...new Set(ids)].slice(0, maxFiles), concurrency, async id => {
        if (!ID.test(id)) { issue('UNKNOWN_ID', '发现未知剧情文件编号。', String(id)); return; }
        if (byteLimit) return;
        try {
            const raw = await store.get(id); abort(signal);
            const json = JSON.stringify(raw), bytes = encoder.encode(json).length;
            totalBytes += bytes;
            if (totalBytes > maxBytes) { byteLimit = true; issue('BYTE_LIMIT', '文件内容超过本次扫描内存上限。'); return; }
            records.set(id, raw);
            files.set(id, { id, kind: raw?.kind ?? 'unknown', bytes, owners: [], referenced: false,
                fingerprint: await sha256Hex(JSON.stringify(canonical(raw))) });
        } catch (error) { abort(signal); issue('READ_FAILED', '剧情文件读取失败或内容无效。', id); }
        onProgress({ phase: 'files', completed: ++finished, total: Math.min(ids.length, maxFiles) });
        if (finished % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }, signal);
    const graph = createStoryStateGraph({ get: async id => {
        abort(signal); if (!records.has(id)) throw new Error('Missing graph record'); return records.get(id);
    }, put: async () => { throw new Error('Read only'); } });
    finished = 0;
    await pool([...records.keys()], concurrency, async id => {
        try {
            const state = await graph.load(id); abort(signal);
            const refs = new Set(), raw = records.get(id);
            if (raw.kind === 'delta') refs.add(raw.parentId);
            if (state.kind === 'amin-story-index') {
                validateIndex(state);
                for (const ref of indexStateIds(state)) refs.add(ref);
                if (state.inheritedFrom != null) {
                    if (!plain(state.inheritedFrom) || typeof state.inheritedFrom.chat !== 'string'
                        || !ID.test(state.inheritedFrom.indexId)) throw new Error('Invalid inherited index');
                    refs.add(state.inheritedFrom.indexId);
                }
                files.get(id).kind = 'index';
            } else if (state.version !== 2 || !plain(state.variables) || !plain(state.rules)
                || !Array.isArray(state.jsonStringRoots) || state.jsonStringRoots.some(key => typeof key !== 'string')) {
                throw new Error('Unknown state schema');
            }
            dependencies.set(id, refs);
        } catch (error) { abort(signal); issue('CORRUPT_FILE', '剧情文件格式、校验或依赖无效。', id); }
        onProgress({ phase: 'references', completed: ++finished, total: records.size });
        if (finished % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }, signal);
    // An orphaned index can still contain missing references: also fail closed.
    for (const [id, refs] of dependencies) for (const ref of refs) if (!files.has(ref)) issue('MISSING_DEPENDENCY', '剧情文件依赖不存在。', id);
    const chats = [], ownerIds = new Set();
    let messageCount = 0;
    for (const entry of entries) {
        abort(signal);
        if (!plain(entry) || typeof entry.id !== 'string' || ownerIds.has(entry.id)
            || !['chat', 'backup'].includes(entry.kind) || !Array.isArray(entry.chat)) {
            issue('INVALID_CHAT', '聊天或备份记录格式无效／标识重复。'); continue;
        }
        ownerIds.add(entry.id);
        const roots = new Set();
        const add = id => { if (!ID.test(id)) throw new Error('Invalid reference'); roots.add(id); };
        try {
            const metadata = entry.chatMetadata ?? entry.metadata;
            if (!plain(metadata)) throw new Error('Missing metadata');
            const marker = metadata[markerKey];
            if (marker !== undefined) {
                if (!plain(marker) || marker.version !== 2 || marker.owner !== 'amin-os/story-v2') throw new Error('Invalid marker');
                add(marker.baseStateId);
                if (marker.indexId !== undefined) add(marker.indexId);
                if (marker.backups !== undefined && !Array.isArray(marker.backups)) throw new Error('Invalid backups');
                for (const backup of marker.backups ?? []) add(backup?.stateId);
            }
            for (const message of entry.chat) {
                if (++messageCount % 500 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); abort(signal); }
                if (!plain(message)) throw new Error('Invalid message');
                if (message.swipe_info !== undefined && !Array.isArray(message.swipe_info)) throw new Error('Invalid swipe info');
                for (const extra of [message.extra, ...(message.swipe_info ?? []).map(info => info?.extra)]) {
                    const ref = extra?.[referenceKey];
                    if (ref === undefined) continue;
                    if (!plain(ref) || ref.version !== 2) throw new Error('Invalid old reference');
                    add(ref.stateId);
                    if (ref.parentStateId != null) add(ref.parentStateId);
                }
            }
        } catch { abort(signal); issue('INVALID_REFERENCE', '聊天或 Swipe 剧情引用无效，禁止清理。', entry.id); }
        const visited = new Set(), pending = [...roots];
        while (pending.length) {
            const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
            const file = files.get(id);
            if (!file) { issue('MISSING_REFERENCE', '聊天引用的外置剧情文件不存在。', entry.id); continue; }
            file.owners.push(entry.id); file.referenced = true;
            pending.push(...(dependencies.get(id) ?? []));
        }
        chats.push({ id: entry.id, label: entry.label ?? entry.id, kind: entry.kind,
            files: visited.size, bytes: 0, exclusiveBytes: 0, sharedBytes: 0,
            documentBytes: Number.isSafeInteger(entry.documentBytes) && entry.documentBytes >= 0 ? entry.documentBytes : null });
        if (chats.length % 20 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); abort(signal); }
    }
    const summary = { files: files.size, bytes: 0, referencedFiles: 0, referencedBytes: 0,
        unreferencedFiles: 0, unreferencedBytes: 0, sharedFiles: 0, sharedBytes: 0,
        chatDocumentBytes: 0, backupDocumentBytes: 0 };
    for (const chat of chats) summary[chat.kind === 'backup' ? 'backupDocumentBytes' : 'chatDocumentBytes'] += chat.documentBytes ?? 0;
    const byChat = new Map(chats.map(chat => [chat.id, chat]));
    for (const file of files.values()) {
        summary.bytes += file.bytes;
        const prefix = file.referenced ? 'referenced' : 'unreferenced';
        summary[`${prefix}Files`]++; summary[`${prefix}Bytes`] += file.bytes;
        if (file.owners.length > 1) { summary.sharedFiles++; summary.sharedBytes += file.bytes; }
        for (const owner of file.owners) {
            const chat = byChat.get(owner); chat.bytes += file.bytes;
            chat[file.owners.length > 1 ? 'sharedBytes' : 'exclusiveBytes'] += file.bytes;
        }
    }
    abort(signal);
    const complete = issues.length === 0;
    const resultFiles = [...files.values()].sort((a, b) => a.id.localeCompare(b.id));
    const fingerprint = await sha256Hex(JSON.stringify([inventory?.fingerprint ?? null,
        resultFiles.map(file => [file.id, file.fingerprint, [...file.owners].sort()])]));
    onProgress({ phase: 'done', completed: files.size, total: files.size });
    return { complete, cleanupBlockedReason: complete ? '' : '扫描覆盖不完整或存在异常，不能据此删除文件。', issues,
        summary, chats, files: resultFiles, observedUnreferenced: resultFiles.filter(file => !file.referenced)
            .map(({ id, bytes, fingerprint }) => ({ id, bytes, fingerprint })), candidates: complete ? resultFiles.filter(file => !file.referenced)
            .map(({ id, bytes, fingerprint }) => ({ id, bytes, fingerprint })) : [],
        duplicateGroups: [], duplicatePolicy: '内容寻址文件已按内容 ID 复用；不同 ID 但相同物化内容会被校验为异常，不自动合并。',
        fingerprint, censusFingerprint: inventory?.fingerprint ?? null,
        bytesKind: 'estimated-json', deletionAuthorized: false,
        capabilities: inventory?.capabilities ?? {}, scope: inventory?.scope ?? 'unspecified',
        deletionBlockedReason: '只读检查不提供全库写入／同步排他保护，不能据此授权删除。' };
}
