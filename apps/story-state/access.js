// The only authoritative Amin story data is the current typed snapshot.
// Legacy shapes below exist only while an existing editor builds a transaction.
export const STATE_KEY = 'amin_os_state_v1';
const codecs = new Map();
let manualPreparation;
const drafts = new WeakMap();
const copy = value => value == null ? value : structuredClone(value);
export const isIndependent = ctx => Object.hasOwn(ctx?.chatMetadata ?? {}, STATE_KEY);
export function readModule(ctx, name) {
    const state = ctx?.chatMetadata?.[STATE_KEY];
    if (!state || state.version !== 1 || !state.modules || typeof state.modules !== 'object') {
        if (isIndependent(ctx)) throw Error('Amin 当前剧情资料格式无效，请导入备份或开始空白资料。');
        return null;
    }
    return copy(state.modules[name] ?? null);
}
export function registerModuleCodec(name, codec) {
    if (!codec || typeof codec.toLegacy !== 'function' || typeof codec.fromLegacy !== 'function') throw TypeError('Invalid story module codec');
    codecs.set(name, codec);
}
export function legacyModule(ctx, name, key) {
    if (!isIndependent(ctx) || Object.hasOwn(ctx.chatMetadata, key)) return ctx?.chatMetadata?.[key];
    const codec = codecs.get(name);
    if (!codec) throw Error(`Amin ${name} 资料转换器未初始化。`);
    return codec.toLegacy(ctx, readModule(ctx, name))?.[key];
}
export function toLegacyContext(ctx) {
    const metadata = structuredClone(ctx?.chatMetadata ?? {});
    const legacy = {...ctx, chatMetadata: metadata};
    if (!isIndependent(ctx)) return legacy;
    delete metadata[STATE_KEY];
    legacy.aminIndependentDraft = true;
    for (const [name, codec] of codecs) {
        const partial = codec.toLegacy(ctx, readModule(ctx, name)) ?? {};
        for (const [key, value] of Object.entries(partial)) {
            if (key === 'variables') metadata.variables = {...metadata.variables, ...copy(value)};
            else metadata[key] = copy(value);
        }
    }
    return legacy;
}
export function extractModules(ctx, base = {}) {
    const result = structuredClone(base);
    const legacy = {...ctx, chatMetadata: structuredClone(ctx.chatMetadata)};
    delete legacy.chatMetadata[STATE_KEY];
    for (const [name, codec] of codecs) result[name] = copy(codec.fromLegacy(legacy));
    return result;
}
const rootNames = {'状态栏':'status', '势力资料':'organizations'};
export function readStoryRoot(ctx, root) {
    if (!isIndependent(ctx) || drafts.get(ctx.chatMetadata)?.has(root)) return ctx?.chatMetadata?.variables?.[root];
    const name = rootNames[root];
    const value = readModule(ctx, name);
    const doc = name === 'organizations' ? value?.doc : value;
    return doc == null ? undefined : JSON.stringify(doc);
}
export function writeStoryRoot(ctx, root, value) {
    ctx.chatMetadata.variables ??= {};
    ctx.chatMetadata.variables[root] = copy(value);
    if (isIndependent(ctx)) {
        let roots = drafts.get(ctx.chatMetadata);
        if (!roots) drafts.set(ctx.chatMetadata, roots = new Set());
        roots.add(root);
    }
}
export const storyRootPath = (_ctx, root) => ['variables',root];
export function clearStoryDrafts(ctx) { drafts.delete(ctx?.chatMetadata); }
export function registerStoryManualPreparation(handler) {
    manualPreparation = handler;
    return () => { if (manualPreparation === handler) manualPreparation = undefined; };
}
export function prepareIndependentManualWrite(ctx, paths) {
    if (!manualPreparation) throw Error('Amin 独立剧情存储尚未初始化，请刷新插件。');
    return manualPreparation(ctx,paths);
}
