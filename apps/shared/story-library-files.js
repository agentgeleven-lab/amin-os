import { createStoryFileStore, STORY_STORE_NAMESPACE, STORY_STORE_TABLE } from './story-file-store.js';

/** Administrative read-only view; never enumerate or mutate another extension table. */
export function createStoryLibraryFileStore({ getHostWindow = () => globalThis.window } = {}) {
    const files = createStoryFileStore({ getHostWindow });
    return {
        get: id => files.get(id),
        async list() {
            const host = getHostWindow();
            await (host?.__TAURITAVERN__?.ready ?? host?.__TAURITAVERN_MAIN_READY__);
            const api = host?.__TAURITAVERN__?.api?.extension?.store;
            if (typeof api?.listKeys !== 'function') throw Error('宿主未提供扩展文件枚举接口。');
            const keys = await api.listKeys({namespace: STORY_STORE_NAMESPACE, table: STORY_STORE_TABLE});
            if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) throw Error('扩展文件目录返回格式无效。');
            const ids = [], unknownKeys = [];
            for (const key of keys) {
                if (/^h-[0-9a-f]{64}$/.test(key)) ids.push('sha256:' + key.slice(2));
                else if (/^k-[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/.test(key)) ids.push(key.slice(2));
                else unknownKeys.push(key);
            }
            return {ids: ids.sort(), unknownKeys: unknownKeys.sort(), complete: unknownKeys.length === 0};
        },
    };
}
