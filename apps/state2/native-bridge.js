import { chatIdentity, chatPath } from '../shared/operations.js';

const getContext = () => globalThis.SillyTavern?.getContext?.();
const importModule = url => import(url);
const extensionEntry = /(?:^|\/)scripts\/extensions\/third-party\/([^/]+)\/index\.js$/iu;
const knownFolder = /littlewhitebox|xiaobai|小白/iu;

/** Resolve only an active, same-origin LittleWhiteBox module entry in the page. */
export function findNativeState2ModuleUrl({ document = globalThis.document, location = globalThis.location } = {}) {
    const base = document?.baseURI || location?.href;
    if (!base) throw Error('无法确定当前页面地址，未定位小白 X 变量模块。');
    const page = new URL(base), candidates = new Set();
    for (const script of Array.from(document?.scripts ?? [])) {
        if (script?.dataset?.tauritavernLoaded === 'false') continue;
        const source = script?.src || script?.getAttribute?.('src');
        if (!source) continue;
        let entry;
        try { entry = new URL(source, page); } catch { continue; }
        // URL.origin is "null" for some desktop custom schemes; compare their
        // protocol and host as well so a file URL cannot masquerade as the page.
        if (entry.origin !== page.origin || page.origin === 'null' && (entry.protocol !== page.protocol || entry.host !== page.host)) continue;
        const match = extensionEntry.exec(entry.pathname);
        if (!match) continue;
        let folder;
        try { folder = decodeURIComponent(match[1]); } catch { continue; }
        if (folder.includes('/') || folder.includes('\\') || !knownFolder.test(folder)) continue;
        const module = new URL('./modules/variables/state2/index.js', entry);
        if (module.origin === page.origin && (page.origin !== 'null' || module.protocol === page.protocol && module.host === page.host)) candidates.add(module.href);
    }
    if (!candidates.size) throw Error('当前页面未找到小白 X 的扩展脚本入口，无法调用原生变量回放。');
    if (candidates.size !== 1) throw Error('当前页面找到多个小白 X 扩展脚本入口，无法确定应使用哪一套变量回放。');
    return [...candidates][0];
}

/** Invoke LittleWhiteBox's own State 2.0 replay after its module is ready. */
export async function restoreNativeState2ToFloor(floor, {
    context = getContext, host = globalThis, document = globalThis.document, importer = importModule,
} = {}) {
    const before = context();
    if (!before?.chatMetadata || before.extensionSettings?.LittleWhiteBox?.variablesMode !== '2.0') {
        throw Error('当前聊天未启用小白 X 变量管理 2.0，无法回放变量。');
    }
    if (!Number.isSafeInteger(floor) || floor < -1 || floor >= (before.chat?.length ?? 0)) {
        throw Error('变量回放的目标楼层无效。');
    }
    const token = { metadata: before.chatMetadata, identity: chatIdentity(before), path: JSON.stringify(chatPath(before.chat)) };
    const stillCurrent = () => {
        const now = context();
        return now?.chatMetadata === token.metadata && now?.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0'
            && chatIdentity(now) === token.identity
            && JSON.stringify(chatPath(now.chat)) === token.path;
    };

    let run, source;
    const publicApi = host?.LWB_StateV2;
    if (typeof publicApi?.applyText !== 'function' && typeof publicApi?.restoreStateV2ToFloor !== 'function') {
        throw Error('小白 X 原生变量 2.0 接口尚未加载，无法回放变量。');
    }
    if (typeof publicApi?.restoreStateV2ToFloor === 'function') {
        run = target => publicApi.restoreStateV2ToFloor(target);
        source = 'global';
    } else {
        const url = findNativeState2ModuleUrl({ document, location: host?.location });
        const module = await importer(url);
        if (typeof module?.restoreStateV2ToFloor !== 'function') throw Error('小白 X 变量模块没有原生楼层回放函数。');
        run = target => module.restoreStateV2ToFloor(target);
        source = 'module';
    }
    // Import can finish after another chat or swipe has become current. Never
    // invoke LittleWhiteBox against that different context.
    if (!stillCurrent()) return { restored: false, stale: true, source };
    const result = await run(floor);
    if (result?.ok === false) throw Error('小白 X 未能回放目标楼层的变量。');
    return { restored: true, stale: !stillCurrent(), source, result };
}
