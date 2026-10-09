import { chatIdentity, chatPath } from '../shared/operations.js';
import { MIGRATION_OWNER, OWNED_VARIABLE_ROOTS, NATIVE_VARIABLE_ROOTS } from './storage.js';
import { findNativeState2ModuleUrl } from './native-bridge.js';
import { sha256HexSync } from '../tts/source-hash.js';

const OWNED = new Set([...OWNED_VARIABLE_ROOTS, ...Object.values(NATIVE_VARIABLE_ROOTS)]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
const getContext = () => globalThis.SillyTavern?.getContext?.();
const importModule = url => import(url);
const BASELINE = 'amin_current_baseline_v1';
const BASELINE_OWNER = 'amin-os/current-baseline-v1';
// LittleWhiteBox accepts dotted and bracketed root paths, including leading dots.
const rootOf = path => {
    const text = String(path ?? '').replace(/^\.+/u, '');
    if (text[0] !== '[') return text.split(/[.\[]/u, 1)[0].trim();
    const match = /^\[(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/u.exec(text);
    return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
};
const sorted = value => Array.isArray(value) ? value.map(sorted) : plain(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const baselineHash = point => {
    const { [BASELINE]: _marker, ...body } = point;
    return 'sha256:' + sha256HexSync(JSON.stringify(sorted(body)));
};
const isSynthetic = point => plain(point?.[BASELINE]) && point[BASELINE].version === 1
    && point[BASELINE].owner === BASELINE_OWNER && point[BASELINE].hash === baselineHash(point);
const ownedRules = rules => Object.fromEntries(Object.entries(rules ?? {}).filter(([path]) => OWNED.has(rootOf(path))));
const fingerprint = (variables, rules) => JSON.stringify(sorted({
    variables: Object.fromEntries([...OWNED].filter(root => own(variables, root)).map(root => [root, variables[root]])),
    rules: ownedRules(rules),
}));
const tokenOf = ctx => ({ metadata: ctx.chatMetadata, identity: chatIdentity(ctx), path: JSON.stringify(chatPath(ctx.chat)) });
const matches = (ctx, token) => ctx?.chatMetadata === token.metadata && chatIdentity(ctx) === token.identity
    && JSON.stringify(chatPath(ctx.chat)) === token.path;

function nativeHistory(metadata, tip) {
    if (metadata.extensions !== undefined && !plain(metadata.extensions)) throw Error('聊天扩展资料格式无效，当前变量未改写。');
    const lwb = metadata.extensions?.LittleWhiteBox;
    if (lwb !== undefined && !plain(lwb)) throw Error('小白 X 扩展资料格式无效，当前变量未改写。');
    const log = lwb?.stateLogV2 === undefined ? { version: 1, floors: {} } : lwb.stateLogV2;
    const checkpoints = lwb?.stateCkptV2 === undefined ? { version: 1, every: 50, points: {} } : lwb.stateCkptV2;
    if (!plain(log) || log.version !== 1 || !plain(log.floors)
        || !plain(checkpoints) || checkpoints.version !== 1 || !plain(checkpoints.points)) {
        throw Error('小白 X 楼层日志或检查点格式不兼容，当前变量未改写。');
    }
    const owner = log.floors['-1'];
    if (owner !== undefined && (!plain(owner) || owner.signature !== MIGRATION_OWNER || !Array.isArray(owner.roots))) {
        throw Error('小白 X 变量归属标记不兼容，当前变量未改写。');
    }
    const allRoots = new Set(OWNED);
    const nextLog = clone(log), nextCheckpoints = clone(checkpoints);
    for (const [floor, record] of Object.entries(nextLog.floors)) {
        if (!plain(record) || record.roots !== undefined && !Array.isArray(record.roots)
            || record.rules !== undefined && !Array.isArray(record.rules)
            || record.ops !== undefined && !Array.isArray(record.ops)) {
            throw Error('小白 X 楼层日志内容不兼容，当前变量未改写。');
        }
        for (const root of record.roots ?? []) allRoots.add(String(root));
        for (const item of [...(record.rules ?? []), ...(record.ops ?? [])]) {
            const root = rootOf(item?.path);
            if (root) allRoots.add(root);
        }
        if (floor === '-1') continue;
        const hasOwned = (record.roots ?? []).some(root => OWNED.has(String(root)))
            || [...(record.rules ?? []), ...(record.ops ?? [])].some(item => OWNED.has(rootOf(item?.path)));
        if (!hasOwned) continue;
        if (record.roots) record.roots = record.roots.filter(root => !OWNED.has(String(root)));
        if (record.rules) record.rules = record.rules.filter(item => !OWNED.has(rootOf(item?.path)));
        if (record.ops) record.ops = record.ops.filter(item => !OWNED.has(rootOf(item?.path)));
        if (!(record.roots?.length || record.rules?.length || record.ops?.length)) delete nextLog.floors[floor];
    }
    nextLog.floors['-1'] = {
        ...(owner ? clone(owner) : { signature: MIGRATION_OWNER, rules: [], ops: [], ts: Date.now() }),
        roots: [...new Set([...(owner?.roots ?? []), ...OWNED])].sort(),
    };
    for (const [floor, checkpoint] of Object.entries(nextCheckpoints.points)) {
        if (!plain(checkpoint) || !plain(checkpoint.vars ?? {}) || !plain(checkpoint.rules ?? {})) {
            throw Error('小白 X 检查点内容不兼容，当前变量未改写。');
        }
        // Only delete complete checkpoints this bridge itself created and that
        // nobody has subsequently changed. A native checkpoint replacement or
        // any foreign addition breaks the digest and must retain its payload.
        if (isSynthetic(checkpoint) && floor !== String(tip)) {
            delete nextCheckpoints.points[floor];
            continue;
        }
        if (own(checkpoint, BASELINE) && !isSynthetic(checkpoint)) delete checkpoint[BASELINE];
        const hasOwned = Object.keys(checkpoint.vars ?? {}).some(root => OWNED.has(root))
            || Object.keys(checkpoint.rules ?? {}).some(path => OWNED.has(rootOf(path)));
        if (!hasOwned) continue;
        for (const root of OWNED) if (checkpoint.vars) delete checkpoint.vars[root];
        if (checkpoint.rules) for (const path of Object.keys(checkpoint.rules)) if (OWNED.has(rootOf(path))) delete checkpoint.rules[path];
        if (!Object.keys(checkpoint.vars ?? {}).length && !Object.keys(checkpoint.rules ?? {}).length
            && Object.keys(checkpoint).every(key => ['vars', 'rules', 'ts', BASELINE].includes(key))) delete nextCheckpoints.points[floor];
    }
    return { log, checkpoints, nextLog, nextCheckpoints, allRoots };
}

/** Overlay only current story roots. Never replay an old floor or inspect Swipe data. */
export async function applyCurrentStoryState(snapshot, {
    context = getContext, host = globalThis, document = globalThis.document, importer = importModule,
    expected, isCurrent = () => true,
} = {}) {
    const before = context();
    if (!plain(before?.chatMetadata) || !Array.isArray(before.chat)
        || !plain(before.chatMetadata.variables ?? {}) || !plain(before.chatMetadata.LWB_RULES_V2 ?? {})) {
        throw Error('当前聊天变量或规则资料格式无效，未改写。');
    }
    const extraCurrent = () => { try { return isCurrent() === true; } catch { return false; } };
    if (expected && !matches(before, expected) || !extraCurrent()) throw Error('聊天已经变化，当前变量未改写。');
    if (!plain(snapshot) || !plain(snapshot.variables) || !plain(snapshot.rules)
        || Object.keys(snapshot.variables).some(root => !OWNED.has(root) || typeof snapshot.variables[root] !== 'string')
        || Object.entries(snapshot.rules).some(([path, rule]) => !OWNED.has(rootOf(path)) || !plain(rule))) {
        throw Error('当前剧情快照包含无效或非剧情变量，未改写。');
    }
    const source = clone(snapshot), metadata = before.chatMetadata, token = tokenOf(before);
    const floor = before.chat.length - 1, history = nativeHistory(metadata, floor);
    const originalLog = metadata.extensions?.LittleWhiteBox?.stateLogV2;
    const originalCheckpoints = metadata.extensions?.LittleWhiteBox?.stateCkptV2;
    const logBefore = JSON.stringify(sorted(originalLog)), checkpointsBefore = JSON.stringify(sorted(originalCheckpoints));
    const rulesChanged = !same(ownedRules(metadata.LWB_RULES_V2), source.rules);
    const rulesBefore = fingerprint(metadata.variables, metadata.LWB_RULES_V2);
    let reloadRules;
    if (rulesChanged) {
        if (typeof host?.LWB_StateV2?.loadRulesFromMeta === 'function') reloadRules = () => host.LWB_StateV2.loadRulesFromMeta();
        else {
            const url = findNativeState2ModuleUrl({ document, location: host?.location });
            const module = await importer(url);
            if (typeof module?.loadRulesFromMeta === 'function') reloadRules = () => module.loadRulesFromMeta();
        }
        if (!reloadRules) throw Error('小白 X 未提供规则表刷新接口，当前规则未改写。');
    }
    // Module loading can allow another operation to change the active variables.
    if (!matches(context(), token) || !extraCurrent()) return { restored: false, stale: true };
    if (fingerprint(metadata.variables, metadata.LWB_RULES_V2) !== rulesBefore
        || metadata.extensions?.LittleWhiteBox?.stateLogV2 !== originalLog
        || metadata.extensions?.LittleWhiteBox?.stateCkptV2 !== originalCheckpoints
        || JSON.stringify(sorted(originalLog)) !== logBefore || JSON.stringify(sorted(originalCheckpoints)) !== checkpointsBefore) {
        throw Error('读取期间当前变量或楼层资料已经变化，未改写。');
    }
    const variables = { ...(metadata.variables ?? {}) }, rules = { ...(metadata.LWB_RULES_V2 ?? {}) };
    for (const root of OWNED) {
        if (own(source.variables, root)) variables[root] = source.variables[root];
        else delete variables[root];
    }
    for (const path of Object.keys(rules)) if (OWNED.has(rootOf(path))) delete rules[path];
    Object.assign(rules, clone(source.rules));
    if (floor >= 0) {
        const existing = history.nextCheckpoints.points[String(floor)];
        const checkpointVars = { ...(existing?.vars ?? {}) }, checkpointRules = { ...(existing?.rules ?? {}) };
        for (const root of history.allRoots) if (own(variables, root)) checkpointVars[root] = clone(variables[root]);
        for (const [path, rule] of Object.entries(rules)) if (history.allRoots.has(rootOf(path))) checkpointRules[path] = clone(rule);
        const original = history.checkpoints.points[String(floor)];
        const contents = { vars: checkpointVars, rules: checkpointRules };
        history.nextCheckpoints.points[String(floor)] = { ...(existing ?? {}), ...contents,
            ts: original && same(original.vars, contents.vars) && same(original.rules, contents.rules) ? original.ts : Date.now() };
        // Preexisting native checkpoints with unrelated data remain native.
        // A pure story checkpoint pruned to nothing can become our one bounded
        // baseline; its original story payload has already been discarded.
        if (!original || isSynthetic(original) || !existing) {
            const point = history.nextCheckpoints.points[String(floor)];
            point[BASELINE] = { version: 1, owner: BASELINE_OWNER, hash: baselineHash(point) };
        }
    }
    const changed = fingerprint(variables, rules) !== rulesBefore || !same(history.log, history.nextLog)
        || !same(history.checkpoints, history.nextCheckpoints);
    const undo = [];
    const write = (parent, key, value) => {
        const exists = own(parent, key), old = parent[key];
        undo.push(() => { if (exists) parent[key] = old; else delete parent[key]; });
        parent[key] = value;
    };
    const container = (parent, key) => {
        if (plain(parent[key])) return parent[key];
        const object = {};
        const exists = own(parent, key), old = parent[key];
        undo.push(() => { if (!Object.keys(object).length) { if (exists) parent[key] = old; else delete parent[key]; } });
        parent[key] = object;
        return object;
    };
    const originalVars = container(metadata, 'variables'), originalRules = container(metadata, 'LWB_RULES_V2');
    for (const root of OWNED) {
        if (own(source.variables, root)) write(originalVars, root, source.variables[root]);
        else if (own(originalVars, root)) { const value = originalVars[root]; undo.push(() => { originalVars[root] = value; }); delete originalVars[root]; }
    }
    const relevant = new Set([...Object.keys(originalRules).filter(path => OWNED.has(rootOf(path))), ...Object.keys(source.rules)]);
    for (const path of relevant) {
        if (own(source.rules, path)) write(originalRules, path, clone(source.rules[path]));
        else { const value = originalRules[path]; undo.push(() => { originalRules[path] = value; }); delete originalRules[path]; }
    }
    const lwb = container(container(metadata, 'extensions'), 'LittleWhiteBox');
    write(lwb, 'stateLogV2', history.nextLog);
    write(lwb, 'stateCkptV2', history.nextCheckpoints);
    const applied = fingerprint(metadata.variables, metadata.LWB_RULES_V2);
    let rolledBack = false;
    const check = () => {
        if (rolledBack || !matches(context(), token) || !extraCurrent()
            || metadata.variables !== originalVars || metadata.LWB_RULES_V2 !== originalRules
            || metadata.extensions?.LittleWhiteBox !== lwb || lwb.stateLogV2 !== history.nextLog || lwb.stateCkptV2 !== history.nextCheckpoints
            || fingerprint(metadata.variables, metadata.LWB_RULES_V2) !== applied
            || !same(lwb.stateLogV2, appliedLog) || !same(lwb.stateCkptV2, appliedCheckpoints)) {
            throw Error('聊天或当前变量已经变化，未保存此剧情操作。');
        }
        return true;
    };
    const appliedLog = clone(history.nextLog), appliedCheckpoints = clone(history.nextCheckpoints);
    const rollback = () => {
        check();
        undo.reverse().forEach(run => run());
        rolledBack = true;
        if (rulesChanged) reloadRules();
        return true;
    };
    try { if (rulesChanged) reloadRules(); check(); }
    catch (error) {
        // The loader must be synchronous. Roll back source metadata even when it
        // throws; reload the original rule table before reporting the failure.
        undo.reverse().forEach(run => run()); rolledBack = true;
        if (rulesChanged && matches(context(), token)) { try { reloadRules(); } catch { /* keep original error */ } }
        throw error;
    }
    return { restored: true, stale: false, floor, changed, check, rollback };
}
