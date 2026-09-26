// TauriTavern keeps each extension-store JSON key in its own file. Its sync
// scope exposes these files as the `extensions.store` dataset. This adapter
// deliberately has no chat-metadata or browser-storage fallback: a reference
// must never be saved unless the pointed-to record was durably written.

import { performanceDiagnostics } from './performance-diagnostics.js';
export const STORY_STORE_NAMESPACE = 'amin-os';
export const STORY_STORE_TABLE = 'story-v2';

export class StoryFileStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'StoryFileStoreError';
    this.code = code;
  }
}

const keyPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const hashIdPattern = /^sha256:([0-9a-f]{64})$/;

function checkedId(id) {
  if (typeof id !== 'string') {
    throw new StoryFileStoreError('STORY_INVALID_ID', '剧情状态 ID 必须是字符串。');
  }
  const hash = hashIdPattern.exec(id);
  if (hash) return { id, key: `h-${hash[1]}` };
  if (!keyPattern.test(id) || id.length > 160) {
    throw new StoryFileStoreError('STORY_INVALID_ID', '剧情状态 ID 必须是 SHA-256 ID 或 1–160 位安全文件名字符。');
  }
  // The prefixes keep a literal `h-...` ID separate from a hash ID.
  return { id, key: `k-${id}` };
}

function assertJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) {
    throw new StoryFileStoreError('STORY_INVALID_JSON', '剧情存储只接受无循环引用的 JSON 数据。');
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new StoryFileStoreError('STORY_INVALID_JSON', '剧情存储只接受普通 JSON 对象。');
  }
  seen.add(value);
  const array = Array.isArray(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const index = typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
    if (typeof key !== 'string' || (array && (!Number.isSafeInteger(index) || index < 0 || index >= value.length))) {
      throw new StoryFileStoreError('STORY_INVALID_JSON', '剧情存储不能包含 JSON 无法保留的属性。');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new StoryFileStoreError('STORY_INVALID_JSON', '剧情存储不能包含 JSON 无法保留的属性。');
    }
    assertJson(descriptor.value, seen);
  }
  if (array) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new StoryFileStoreError('STORY_INVALID_JSON', '剧情存储不能包含空数组项。');
    }
  }
  seen.delete(value);
}

function copyJson(value) {
  assertJson(value);
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Create a file-backed immutable-record store. The optional host-window
 * provider allows tests and embedded frames to supply the owning TT window.
 * This store is global; callers put a stable chat identity into their record
 * IDs where isolation is needed.
 */
export function createStoryFileStore({ getHostWindow = () => globalThis.window } = {}) {
  function currentStore(hostWindow) {
    const store = hostWindow?.__TAURITAVERN__?.api?.extension?.store;
    return typeof store?.tryGetJson === 'function' && typeof store?.setJson === 'function' ? store : null;
  }

  async function requireStore() {
    const hostWindow = getHostWindow();
    const ready = hostWindow?.__TAURITAVERN__?.ready ?? hostWindow?.__TAURITAVERN_MAIN_READY__;
    if (ready && typeof ready.then === 'function') {
      try {
        await ready;
      } catch (cause) {
        throw new StoryFileStoreError('STORY_STORE_UNAVAILABLE', 'TauriTavern 扩展文件存储初始化失败。', { cause });
      }
    }
    const store = currentStore(hostWindow);
    if (!store) {
      throw new StoryFileStoreError(
        'STORY_STORE_UNAVAILABLE',
        'TauriTavern 扩展文件存储不可用；剧情状态没有写入，请勿保存只含状态引用的楼层。',
      );
    }
    return store;
  }

  async function read(store, id) {
    let result;
    const finished = performanceDiagnostics.begin('fileRead');
    try {
      result = await store.tryGetJson({ namespace: STORY_STORE_NAMESPACE, table: STORY_STORE_TABLE, key: id });
      finished();
    } catch (cause) {
      finished({failed:true});
      throw new StoryFileStoreError('STORY_READ_FAILED', `无法读取剧情状态 ${id}。`, { cause });
    }
    if (!result || typeof result.found !== 'boolean' || (result.found && !Object.hasOwn(result, 'value'))) {
      throw new StoryFileStoreError('STORY_STORE_INVALID_RESPONSE', 'TauriTavern 扩展文件存储返回了无效结果。');
    }
    if (!result.found) return { found: false };
    try {
      return { found: true, value: copyJson(result.value) };
    } catch (cause) {
      throw new StoryFileStoreError('STORY_STORE_CORRUPT', `剧情状态 ${id} 不是有效的 JSON 数据。`, { cause });
    }
  }

  return Object.freeze({
    // This is a synchronous capability check, not a durability probe.
    available() {
      try {
        return !!currentStore(getHostWindow());
      } catch {
        return false;
      }
    },

    async get(id) {
      const target = checkedId(id);
      const entry = await read(await requireStore(), target.key);
      if (!entry.found) {
        throw new StoryFileStoreError('STORY_NOT_FOUND', `找不到剧情状态 ${target.id}；请检查另一设备是否同步了扩展存储。`);
      }
      return entry.value;
    },

    async put(id, value) {
      const target = checkedId(id);
      const snapshot = copyJson(value);
      const signature = canonicalJson(snapshot);
      const store = await requireStore();
      const existing = await read(store, target.key);
      if (existing.found) {
        if (canonicalJson(existing.value) !== signature) {
          throw new StoryFileStoreError('STORY_ID_CONFLICT', `剧情状态 ${target.id} 已存在不同内容，不能覆盖。`);
        }
        return;
      }
      const finished = performanceDiagnostics.begin('fileWrite');
      try {
        await store.setJson({ namespace: STORY_STORE_NAMESPACE, table: STORY_STORE_TABLE, key: target.key, value: snapshot });
        finished({bytes:performanceDiagnostics.enabled() ? new TextEncoder().encode(signature).length : 0});
      } catch (cause) {
        finished({failed:true});
        throw new StoryFileStoreError('STORY_WRITE_FAILED', `无法保存剧情状态 ${target.id}。`, { cause });
      }
      const saved = await read(store, target.key);
      if (!saved.found || canonicalJson(saved.value) !== signature) {
        throw new StoryFileStoreError('STORY_WRITE_VERIFY_FAILED', `剧情状态 ${target.id} 写入后校验失败。`);
      }
    },
  });
}
