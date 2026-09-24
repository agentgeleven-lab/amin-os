import { chatIdentity, chatPath } from '../shared/operations.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS } from './storage.js';

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

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const rootOf = path => String(path ?? '').split(/[.\[]/, 1)[0];
const contextToken = ctx => ({ metadata: ctx.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx.chat)) });
const matchesToken = (ctx, token) => ctx?.chatMetadata === token.metadata && chatIdentity(ctx) === token.identity
    && JSON.stringify(chatPath(ctx.chat)) === token.path;
const nativeRoots = Object.values(NATIVE_VARIABLE_ROOTS);
function stableJSON(value) {
    if (Array.isArray(value)) return value.map(stableJSON);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJSON(value[key])]));
    return value;
}
function sameJSON(a, b) {
    try { return JSON.stringify(stableJSON(a)) === JSON.stringify(stableJSON(b)); }
    catch { return false; }
}
function sameVariable(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try { return sameJSON(JSON.parse(a), JSON.parse(b)); }
    catch { return false; }
}
function logRoots(log) {
    const roots = new Set();
    for (const record of Object.values(log.floors)) {
        if (Array.isArray(record?.roots)) for (const root of record.roots) roots.add(String(root));
        else for (const entry of [...(record?.rules ?? []), ...(record?.ops ?? [])]) {
            const root = rootOf(entry?.path);
            if (root) roots.add(root);
        }
    }
    return roots;
}

/**
 * Restore the selected branch through LittleWhiteBox, then establish an exact
 * current-floor baseline for Amin-owned roots. Historical inspection must use
 * the external snapshot directly; this function changes live variables.
 *
 * LittleWhiteBox owns its WAL and applied signatures. Keep both untouched and
 * write a checkpoint at the branch tip so its next replay starts from the
 * external state while retaining unrelated State 2.0 roots and rules.
 */
export async function restoreExternalState2SnapshotToFloor(floor, snapshot, {
    context = getContext, host = globalThis, document = globalThis.document, importer = importModule,
    expected, forGeneration = false, isCurrent = () => true,
} = {}) {
    const before = context();
    if (!before?.chatMetadata || before.extensionSettings?.LittleWhiteBox?.variablesMode !== '2.0') {
        throw Error('当前聊天未启用小白 X 变量管理 2.0，无法恢复外置状态。');
    }
    const tip = (before.chat?.length ?? 0) - 1;
    if (!Number.isSafeInteger(floor) || floor < 0 || floor !== tip - (forGeneration === true ? 1 : 0)) {
        throw Error(forGeneration ? '候选生成只能恢复当前助手消息的前一楼。' : '外置状态只能恢复到当前分支末尾楼层。');
    }
    if (forGeneration === true && (before.chat[tip]?.is_user || before.chat[tip]?.is_system)) {
        throw Error('候选生成恢复要求末尾是待替换的助手消息。');
    }
    const extraCurrent = () => { try { return isCurrent() === true; } catch { return false; } };
    if ((expected && !matchesToken(before, expected)) || !extraCurrent()) throw Error('聊天或候选已变化，外置状态未恢复。');
    if (!plain(snapshot) || !plain(snapshot.variables) || !plain(snapshot.rules)) {
        throw Error('外置状态缺少有效的变量或规则资料。');
    }
    const metadata = before.chatMetadata, lwb = metadata.extensions?.LittleWhiteBox;
    const log = lwb?.stateLogV2, checkpoints = lwb?.stateCkptV2;
    const owner = log?.floors?.['-1'];
    if (log?.version !== 1 || !plain(log.floors) || checkpoints?.version !== 1 || !plain(checkpoints.points)
        || owner?.signature !== MIGRATION_OWNER || !Array.isArray(owner.roots)
        || !OWNED_VARIABLE_ROOTS.every(root => owner.roots.includes(root))) {
        throw Error('小白 X 楼层日志、检查点或 Amin 变量归属不兼容，外置状态未恢复。');
    }
    // These two native variable roots are also OS story state. An old floor
    // with no value must clear a future value even if a legacy chat never
    // registered that root in LittleWhiteBox's ownership log.
    const aminRoots = new Set([...OWNED_VARIABLE_ROOTS, ...nativeRoots]);
    for (const root of aminRoots) {
        if (own(snapshot.variables, root) && typeof snapshot.variables[root] !== 'string') {
            throw Error(`外置状态的「${root}」不是小白变量字符串。`);
        }
    }
    for (const [path, rule] of Object.entries(snapshot.rules)) {
        if (aminRoots.has(rootOf(path)) && !plain(rule)) throw Error(`外置状态的规则「${path}」无效。`);
    }
    // Reject data that structuredClone cannot safely copy before native replay
    // starts changing the active chat.
    const token = contextToken(before);
    const source = clone(snapshot);
    // Resolve the rule-cache loader before native replay mutates variables.
    // Any missing bridge then fails without leaving a half-restored branch.
    let reloadRules = host?.LWB_StateV2?.loadRulesFromMeta;
    if (typeof reloadRules !== 'function') {
        const url = findNativeState2ModuleUrl({ document, location: host?.location });
        const module = await importer(url);
        reloadRules = module?.loadRulesFromMeta;
    }
    if (typeof reloadRules !== 'function') throw Error('小白 X 未提供规则表刷新接口，外置规则未恢复。');
    if (!matchesToken(context(), token) || !extraCurrent()) return { restored: false, stale: true };
    const result = await restoreNativeState2ToFloor(floor, { context, host, document, importer });
    if (!result.restored || result.stale || !matchesToken(context(), token) || !extraCurrent()) return { ...result, restored: false, stale: true };

    const current = context().chatMetadata;
    const currentLog = current.extensions?.LittleWhiteBox?.stateLogV2;
    const currentCkpt = current.extensions?.LittleWhiteBox?.stateCkptV2;
    if (currentLog?.version !== 1 || !plain(currentLog.floors) || currentCkpt?.version !== 1 || !plain(currentCkpt.points)
        || currentLog.floors['-1']?.signature !== MIGRATION_OWNER) {
        throw Error('原生回放后小白 X 楼层资料发生变化，外置状态未覆盖。');
    }
    if (!plain(current.variables) || current.LWB_RULES_V2 !== undefined && !plain(current.LWB_RULES_V2)) {
        throw Error('原生回放后变量或规则资料格式无效，外置状态未覆盖。');
    }
    // A native status/organization root may first appear in this external
    // snapshot. Claim it in Amin's existing ownership sentinel so subsequent
    // LittleWhiteBox replay includes and clears it at the right floor.
    const ownerAfter = currentLog.floors['-1'];
    const nextOwnerRoots = [...new Set([...ownerAfter.roots, ...nativeRoots])].sort();
    const ownerChanged = JSON.stringify(nextOwnerRoots) !== JSON.stringify([...ownerAfter.roots].sort());
    const variablesChanged = [...aminRoots].some(root => own(current.variables, root) !== own(source.variables, root)
        || own(source.variables, root) && !sameVariable(current.variables[root], source.variables[root]));
    const relevantRules = new Set([
        ...Object.keys(current.LWB_RULES_V2 ?? {}).filter(path => aminRoots.has(rootOf(path))),
        ...Object.keys(source.rules).filter(path => aminRoots.has(rootOf(path))),
    ]);
    const rulesChanged = [...relevantRules].some(path => own(current.LWB_RULES_V2, path) !== own(source.rules, path)
        || own(source.rules, path) && !sameJSON(current.LWB_RULES_V2[path], source.rules[path]));
    // In the common case the native WAL already reconstructs the external
    // snapshot. Do not add a full checkpoint just because the chat was opened.
    if (!ownerChanged && !variablesChanged && !rulesChanged) {
        return { ...result, external: true, floor, baseline: 'native' };
    }
    const variables = { ...(plain(current.variables) ? current.variables : {}) };
    for (const root of aminRoots) {
        if (own(source.variables, root)) variables[root] = source.variables[root];
        else delete variables[root];
    }
    const rules = { ...(plain(current.LWB_RULES_V2) ? current.LWB_RULES_V2 : {}) };
    for (const path of Object.keys(rules)) if (aminRoots.has(rootOf(path))) delete rules[path];
    for (const [path, rule] of Object.entries(source.rules)) if (aminRoots.has(rootOf(path))) rules[path] = rule;

    // Native checkpoints are scoped to every State 2.0-owned root, including
    // non-Amin roots. A full metadata snapshot here would copy unrelated data.
    const allOwned = logRoots(currentLog);
    for (const root of nextOwnerRoots) allOwned.add(root);
    const checkpointVars = {}, checkpointRules = {};
    for (const root of allOwned) if (own(variables, root)) checkpointVars[root] = clone(variables[root]);
    for (const [path, rule] of Object.entries(rules)) if (allOwned.has(rootOf(path))) checkpointRules[path] = clone(rule);
    // Commit all related fields together after the replay and context checks.
    current.variables = variables;
    current.LWB_RULES_V2 = rules;
    ownerAfter.roots = nextOwnerRoots;
    currentCkpt.points[String(floor)] = { vars: checkpointVars, rules: checkpointRules, ts: Date.now() };
    // Rules are cached inside LittleWhiteBox separately from chat metadata.
    // Its synchronous loader must see the final rules before the next <state>.
    if (rulesChanged) reloadRules();
    // Reset the native debounce after the final overlay. Otherwise a slow
    // module import could let its earlier scheduled save persist only replay.
    context().saveMetadataDebounced?.();
    return { ...result, external: true, floor, baseline: 'checkpoint' };
}
