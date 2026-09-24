// Immutable, content-addressed story states. The caller owns the backing store
// and the message-to-state references; this module never touches chat metadata.
import { sha256Hex } from '../tts/source-hash.js';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ENCODER = new TextEncoder();
const DEFAULTS = Object.freeze({ maxDeltaDepth: 8, maxBytes: 32 * 1024 * 1024, maxEntries: 200_000, maxChanges: 50_000 });

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function canonical(value, limits, seen = new WeakSet(), depth = 0, count = { value: 0 }) {
    if (depth > 80) throw failure('STORY_STATE_INVALID', '剧情状态嵌套过深。');
    if (++count.value > limits.maxEntries) throw failure('STORY_STATE_INVALID', '剧情状态条目过多。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)))
        throw failure('STORY_STATE_INVALID', '剧情状态必须是普通 JSON 数据。');
    if (seen.has(value)) throw failure('STORY_STATE_INVALID', '剧情状态不能包含循环引用。');
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        if (value.length > limits.maxEntries) throw failure('STORY_STATE_INVALID', '剧情状态数组过大。');
        result = Array.from({ length: value.length }, (_, index) => {
            if (!own(value, index)) throw failure('STORY_STATE_INVALID', '剧情状态不能包含数组空位。');
            return canonical(value[index], limits, seen, depth + 1, count);
        });
    } else {
        if (Object.keys(value).length > limits.maxEntries) throw failure('STORY_STATE_INVALID', '剧情状态对象过大。');
        result = {};
        for (const key of Object.keys(value).sort()) {
            if (BLOCKED_KEYS.has(key)) throw failure('STORY_STATE_INVALID', '剧情状态包含不安全的字段名。');
            result[key] = canonical(value[key], limits, seen, depth + 1, count);
        }
    }
    seen.delete(value);
    return result;
}

function normalize(value, limits, objectRequired = false) {
    const result = canonical(value, limits);
    if (objectRequired && !plain(result)) throw failure('STORY_STATE_INVALID', '剧情状态根节点必须是 JSON 对象。');
    if (ENCODER.encode(JSON.stringify(result)).byteLength > limits.maxBytes)
        throw failure('STORY_STATE_INVALID', '剧情状态超过外置存储单项大小上限。');
    return result;
}

async function digest(value) {
    return `sha256:${await sha256Hex(JSON.stringify(canonical(value, { maxEntries: Number.MAX_SAFE_INTEGER })))}`;
}

function assertId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw failure('STORY_STATE_INVALID', '剧情状态引用格式无效。');
}

function diff(before, after, path = [], changes = []) {
    if (Object.is(before, after)) return changes;
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
        for (let index = 0; index < after.length; index++) diff(before[index], after[index], [...path, index], changes);
    } else if (plain(before) && plain(after)) {
        for (const key of Object.keys(before)) if (!own(after, key)) changes.push({ op: 'delete', path: [...path, key] });
        for (const key of Object.keys(after)) {
            if (!own(before, key)) changes.push({ op: 'set', path: [...path, key], value: after[key] });
            else diff(before[key], after[key], [...path, key], changes);
        }
    } else changes.push({ op: 'set', path, value: after });
    return changes;
}

function applyChanges(parent, changes, limits) {
    const value = normalize(parent, limits, true);
    if (!Array.isArray(changes) || changes.length > limits.maxChanges)
        throw failure('STORY_STATE_CORRUPT', '剧情状态变化记录格式无效。');
    for (const change of changes) {
        if (!plain(change) || !['set', 'delete'].includes(change.op) || !Array.isArray(change.path)
            || change.path.length < 1 || change.path.length > 80 || (change.op === 'set') !== own(change, 'value'))
            throw failure('STORY_STATE_CORRUPT', '剧情状态变化记录格式无效。');
        let target = value;
        for (const part of change.path.slice(0, -1)) {
            if (BLOCKED_KEYS.has(part) || (Array.isArray(target) ? !Number.isSafeInteger(part) || part < 0 || part >= target.length
                : !plain(target) || typeof part !== 'string' || !own(target, part)))
                throw failure('STORY_STATE_CORRUPT', '剧情状态变化路径无效。');
            target = target[part];
        }
        const key = change.path.at(-1);
        if (BLOCKED_KEYS.has(key)) throw failure('STORY_STATE_CORRUPT', '剧情状态变化路径不安全。');
        if (Array.isArray(target)) {
            if (!Number.isSafeInteger(key) || key < 0 || key >= target.length || change.op === 'delete')
                throw failure('STORY_STATE_CORRUPT', '剧情状态数组变化路径无效。');
        } else if (!plain(target) || typeof key !== 'string' || (change.op === 'delete' && !own(target, key)))
            throw failure('STORY_STATE_CORRUPT', '剧情状态变化路径无效。');
        if (change.op === 'delete') delete target[key];
        else target[key] = normalize(change.value, limits);
    }
    return normalize(value, limits, true);
}

function nodeShape(raw, limits) {
    let node;
    // A node wraps the state with a small amount of metadata. Its limit must
    // leave room for that wrapper even when the state is at its own limit.
    try { node = normalize(raw, { ...limits, maxBytes: limits.maxBytes + 65_536,
        maxEntries: limits.maxEntries * 2 + 1_000 }); }
    catch { throw failure('STORY_STATE_CORRUPT', '剧情状态文件格式无效。'); }
    if (!plain(node) || node.version !== 1 || !ID_PATTERN.test(node.digest ?? ''))
        throw failure('STORY_STATE_CORRUPT', '剧情状态文件格式无效。');
    const keys = Object.keys(node).sort().join(',');
    if (node.kind === 'snapshot') {
        if (keys !== 'depth,digest,kind,state,version' || node.depth !== 0 || !plain(node.state))
            throw failure('STORY_STATE_CORRUPT', '剧情状态检查点格式无效。');
    } else if (node.kind === 'delta') {
        if (keys !== 'changes,depth,digest,kind,parentId,version' || !ID_PATTERN.test(node.parentId ?? '')
            || !Number.isSafeInteger(node.depth) || node.depth < 1 || node.depth > 64 || !Array.isArray(node.changes))
            throw failure('STORY_STATE_CORRUPT', '剧情状态差量格式无效。');
    } else throw failure('STORY_STATE_CORRUPT', '剧情状态文件类型无效。');
    return node;
}

export function createStoryStateGraph(store, options = {}) {
    if (typeof store?.get !== 'function' || typeof store?.put !== 'function')
        throw new TypeError('剧情状态存储需要 async get(id) 和 put(id, value)。');
    const limits = { ...DEFAULTS, ...options };
    if (!Number.isSafeInteger(limits.maxDeltaDepth) || limits.maxDeltaDepth < 0 || limits.maxDeltaDepth > 64)
        throw new TypeError('maxDeltaDepth 必须为 0 至 64 的整数。');
    for (const key of ['maxBytes', 'maxEntries', 'maxChanges'])
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new TypeError(`${key} 必须为正整数。`);

    async function read(id, source, cache = new Map(), visiting = new Set()) {
        assertId(id);
        if (cache.has(id)) return cache.get(id);
        if (visiting.has(id) || visiting.size > 64) throw failure('STORY_STATE_CORRUPT', '剧情状态父链包含循环或过长。');
        visiting.add(id);
        try {
            const raw = await source(id);
            if (raw == null) throw failure('STORY_STATE_MISSING', `找不到剧情状态 ${id}。`);
            const node = nodeShape(raw, limits);
            const { digest: recorded, ...body } = node;
            if (await digest(body) !== recorded) throw failure('STORY_STATE_CORRUPT', `剧情状态 ${id} 校验失败。`);
            let state;
            if (node.kind === 'snapshot') state = normalize(node.state, limits, true);
            else {
                const parent = await read(node.parentId, source, cache, visiting);
                if (node.depth !== parent.depth + 1) throw failure('STORY_STATE_CORRUPT', '剧情状态父链深度无效。');
                state = applyChanges(parent.state, node.changes, limits);
            }
            if (await digest(state) !== id) throw failure('STORY_STATE_CORRUPT', `剧情状态 ${id} 内容校验失败。`);
            const result = { state, depth: node.depth, node };
            cache.set(id, result);
            return result;
        } finally { visiting.delete(id); }
    }

    const fromStore = async id => {
        try { return await store.get(id); }
        catch (error) {
            if (error?.code === 'STORY_NOT_FOUND') return null;
            throw error;
        }
    };
    return {
        async save(value, { parentId = null } = {}) {
            const state = normalize(value, limits, true);
            const id = await digest(state);
            let parent = null;
            if (parentId != null) {
                assertId(parentId);
                parent = await read(parentId, fromStore);
                if (id === parentId) return id;
            }
            if (await fromStore(id) != null) {
                await read(id, fromStore);
                return id;
            }
            const snapshot = { version: 1, kind: 'snapshot', depth: 0, state };
            let body = snapshot;
            if (parent && parent.depth < limits.maxDeltaDepth) {
                const changes = diff(parent.state, state);
                const delta = { version: 1, kind: 'delta', depth: parent.depth + 1, parentId, changes };
                if (changes.length <= limits.maxChanges && JSON.stringify(delta).length < JSON.stringify(snapshot).length)
                    body = delta;
            }
            try { await store.put(id, { ...body, digest: await digest(body) }); }
            catch (error) {
                // Concurrent devices may write the same logical state using
                // different parents. Either valid representation is reusable.
                try { await read(id, fromStore); }
                catch { throw error; }
            }
            return id;
        },
        async load(id) { return normalize((await read(id, fromStore)).state, limits, true); },
        async exportClosure(stateIds) {
            if (!Array.isArray(stateIds)) throw new TypeError('stateIds 必须是数组。');
            const roots = [...new Set(stateIds)];
            const nodes = {};
            const cache = new Map();
            for (const id of roots) await read(id, fromStore, cache);
            for (const [id, record] of cache) nodes[id] = record.node;
            return { version: 1, roots, nodes };
        },
        async importClosure(bundle) {
            if (!plain(bundle) || bundle.version !== 1 || !Array.isArray(bundle.roots) || !plain(bundle.nodes))
                throw failure('STORY_STATE_INVALID', '剧情状态导入包格式无效。');
            const ids = Object.keys(bundle.nodes);
            if (ids.length > limits.maxEntries || bundle.roots.length > limits.maxEntries)
                throw failure('STORY_STATE_INVALID', '剧情状态导入包条目过多。');
            for (const id of [...bundle.roots, ...ids]) assertId(id);
            const source = async id => own(bundle.nodes, id) ? bundle.nodes[id] : null;
            const cache = new Map();
            for (const id of ids) await read(id, source, cache);
            for (const id of bundle.roots) await read(id, source, cache);
            // Validate the complete closure before making the first write.
            const written = new Set();
            const write = async id => {
                if (written.has(id)) return;
                const node = cache.get(id).node;
                if (node.kind === 'delta') await write(node.parentId);
                if (await fromStore(id) != null) await read(id, fromStore);
                else {
                    try { await store.put(id, node); }
                    catch (error) {
                        try { await read(id, fromStore); }
                        catch { throw error; }
                    }
                }
                written.add(id);
            };
            for (const id of ids) await write(id);
        },
    };
}
