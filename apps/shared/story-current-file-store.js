// Mutable current-variable records live separately from immutable story-v2.
// A service owns the record schema, snapshot checksums and five-backup bound.
// TT exposes no compare-and-swap transaction: expected/readback checks detect
// observed conflicts, but cannot make the cross-device read/write gap atomic.
export const STORY_CURRENT_STORE_NAMESPACE = 'amin-os';
export const STORY_CURRENT_STORE_TABLE = 'story-current-v1';

export class StoryCurrentFileStoreError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'StoryCurrentFileStoreError';
        this.code = code;
    }
}
const fail = (code, message, cause) => {
    throw new StoryCurrentFileStoreError(code, message, cause === undefined ? undefined : { cause });
};
const plain = value => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const pendingByStore = new WeakMap();
function checkedKey(key) {
    if (typeof key !== 'string' || !/^current-[A-Za-z0-9_-]{1,100}$/.test(key))
        fail('STORY_CURRENT_INVALID_KEY', '当前变量记录需要 current- 开头的安全文件标识。');
    return key;
}
function assertJson(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)
        || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)))
        fail('STORY_CURRENT_INVALID_JSON', '当前变量记录只接受普通、无循环引用的 JSON 数据。');
    seen.add(value);
    const array = Array.isArray(value);
    for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        const index = typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
            || array && (!Number.isSafeInteger(index) || index < 0 || index >= value.length))
            fail('STORY_CURRENT_INVALID_JSON', '当前变量记录不能包含访问器或 JSON 无法保留的属性。');
        assertJson(descriptor.value, seen);
    }
    if (array) for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) fail('STORY_CURRENT_INVALID_JSON', '当前变量记录不能包含空数组项。');
    }
    seen.delete(value);
}
function copyRecord(value) {
    if (!plain(value)) fail('STORY_CURRENT_INVALID_JSON', '当前变量记录根节点必须是普通 JSON 对象。');
    assertJson(value);
    return JSON.parse(JSON.stringify(value));
}
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function createStoryCurrentFileStore({ getHostWindow = () => globalThis.window } = {}) {
    const currentStore = host => {
        const store = host?.__TAURITAVERN__?.api?.extension?.store;
        return typeof store?.tryGetJson === 'function' && typeof store?.setJson === 'function' ? store : null;
    };
    async function requireStore() {
        let host;
        try { host = getHostWindow(); }
        catch (cause) { fail('STORY_CURRENT_STORE_UNAVAILABLE', '无法访问 TauriTavern 当前变量文件存储。', cause); }
        const ready = host?.__TAURITAVERN__?.ready ?? host?.__TAURITAVERN_MAIN_READY__;
        if (ready && typeof ready.then === 'function') {
            try { await ready; }
            catch (cause) { fail('STORY_CURRENT_STORE_UNAVAILABLE', 'TauriTavern 当前变量文件存储初始化失败。', cause); }
        }
        const store = currentStore(host);
        if (!store) fail('STORY_CURRENT_STORE_UNAVAILABLE', 'TauriTavern 当前变量文件存储不可用，记录尚未写入。');
        return store;
    }
    async function read(store, key) {
        let result;
        try { result = await store.tryGetJson({ namespace: STORY_CURRENT_STORE_NAMESPACE, table: STORY_CURRENT_STORE_TABLE, key }); }
        catch (cause) { fail('STORY_CURRENT_READ_FAILED', `无法读取当前变量记录 ${key}。`, cause); }
        const found = result && Object.getOwnPropertyDescriptor(result, 'found');
        if (!found || !Object.hasOwn(found, 'value') || typeof found.value !== 'boolean')
            fail('STORY_CURRENT_INVALID_RESPONSE', 'TauriTavern 当前变量文件存储返回了无效读取结果。');
        if (!found.value) return null;
        const value = Object.getOwnPropertyDescriptor(result, 'value');
        if (!value || !Object.hasOwn(value, 'value'))
            fail('STORY_CURRENT_INVALID_RESPONSE', 'TauriTavern 当前变量文件存储没有返回记录内容。');
        try { return copyRecord(value.value); }
        catch (cause) { fail('STORY_CURRENT_STORE_CORRUPT', `当前变量记录 ${key} 不是有效的 JSON 对象。`, cause); }
    }
    return Object.freeze({
        // Capability only; readiness and I/O are checked by get/put.
        available() { try { return !!currentStore(getHostWindow()); } catch { return false; } },
        async get(key) { key = checkedKey(key); return read(await requireStore(), key); },
        async put(key, value, options) {
            key = checkedKey(key);
            const snapshot = copyRecord(value);
            const descriptor = options && Object.getOwnPropertyDescriptor(options, 'expected');
            if (!descriptor || !Object.hasOwn(descriptor, 'value'))
                fail('STORY_CURRENT_EXPECTED_REQUIRED', '保存当前变量记录时必须提供预期旧记录；新记录使用 null。');
            const expected = descriptor.value === null ? null : copyRecord(descriptor.value);
            const signature = canonical(snapshot), expectedSignature = expected === null ? null : canonical(expected);
            const store = await requireStore();
            let pending = pendingByStore.get(store);
            if (!pending) pendingByStore.set(store, pending = new Set());
            if (pending.has(key)) fail('STORY_CURRENT_CONFLICT', '当前变量记录正在保存，请等待完成后重新读取。');
            pending.add(key);
            try {
                const existing = await read(store, key);
                if ((existing === null ? null : canonical(existing)) !== expectedSignature)
                    fail('STORY_CURRENT_CONFLICT', '当前变量记录已被其他操作修改，请重新读取后再保存。');
                try {
                    await store.setJson({ namespace: STORY_CURRENT_STORE_NAMESPACE, table: STORY_CURRENT_STORE_TABLE, key, value: snapshot });
                } catch (cause) { fail('STORY_CURRENT_WRITE_FAILED', `无法保存当前变量记录 ${key}。`, cause); }
                const saved = await read(store, key);
                if (saved === null || canonical(saved) !== signature)
                    fail('STORY_CURRENT_WRITE_VERIFY_FAILED', `当前变量记录 ${key} 写入后回读校验失败。`);
            } finally { pending.delete(key); }
        },
    });
}
