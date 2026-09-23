import { chatIdentity } from '../shared/operations.js';
import { prepareUpdateEntry } from '../status/lorebook.js';

export const LINKAGE_OWNER_FIELD = 'amin_os_linkage_owner';
export const LINKAGE_ENTRY_MARKER = 'amin-os/linkage-v1';
export const LINKAGE_ENTRY_TITLE = 'Amin OS · 剧情状态更新';
export const LINKAGE_PLACEHOLDER = '{{amin_os_linkage}}';
export const LINKAGE_ENTRY_TEMPLATE = LINKAGE_PLACEHOLDER;

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const installing = new Set();

export const isUnifiedEntry = entry => entry?.[LINKAGE_OWNER_FIELD] === LINKAGE_ENTRY_MARKER;
export function hasUnifiedPlaceholder(content) {
    return typeof content === 'string' && content.split(LINKAGE_PLACEHOLDER).length === 2;
}

export function unifiedWorldbookTarget(ctx) {
    const id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
    if (id == null || id === '' || !ctx?.chatMetadata) throw Error('请先打开需要启用联动的聊天。');
    const chatBook = ctx.chatMetadata.world_info;
    if (typeof chatBook === 'string' && chatBook.trim()) return chatBook;
    const character = ctx.groupId == null ? ctx.characters?.[ctx.characterId] : null;
    const characterBook = character?.data?.extensions?.world || character?.extensions?.world;
    if (typeof characterBook === 'string' && characterBook.trim()) return characterBook;
    throw Error('当前聊天未绑定世界书。请绑定聊天世界书或角色主世界书后重试。');
}

function ownedEntries(book) {
    if (!book?.entries || typeof book.entries !== 'object' || Array.isArray(book.entries)) throw Error('世界书格式不兼容，未修改。');
    const entries = Object.values(book.entries).filter(isUnifiedEntry);
    if (entries.length > 1) throw Error('世界书中有多个 Amin OS 联动条目，请保留一个后重试。');
    return entries;
}

/** A persisted entry is only a template. Never pass current-chat state here. */
export function prepareUnifiedWorldbook(original, name, createEntry) {
    const previous = ownedEntries(original)[0];
    if (previous) {
        if (!hasUnifiedPlaceholder(previous.content)) throw Error(`统一条目必须保留且只保留一个 ${LINKAGE_PLACEHOLDER} 占位；请先在世界书中修复。`);
        // Position, triggers, disabled state and user rules belong to the user.
        // Reinstalling must not silently reset their editor choices.
        return { book: clone(original), entry: clone(previous), previous: clone(previous), changed: false };
    }
    return prepareUpdateEntry(original, name, createEntry, '', {
        ownerField: LINKAGE_OWNER_FIELD, marker: LINKAGE_ENTRY_MARKER, title: LINKAGE_ENTRY_TITLE,
        prompt: LINKAGE_ENTRY_TEMPLATE, enabled: true,
    });
}

function requestApi(ctx, fetcher) {
    if (typeof ctx.getRequestHeaders !== 'function') throw Error('当前酒馆未提供世界书请求接口，未修改。');
    return async (route, body) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetcher('/api/worldinfo/' + route, {
                method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(body),
                signal: controller.signal, cache: 'no-store',
            });
            if (!response.ok) throw Error(`世界书${route === 'get' ? '读取' : '保存'}失败（${response.status}）。`);
            return route === 'get' ? await response.json() : null;
        } finally { clearTimeout(timer); }
    };
}

function captureBook(getContext) {
    const ctx = getContext(), name = unifiedWorldbookTarget(ctx), identity = chatIdentity(ctx), metadata = ctx.chatMetadata;
    return { ctx, name, guard() {
        const now = getContext();
        if (now?.chatMetadata !== metadata || chatIdentity(now) !== identity || unifiedWorldbookTarget(now) !== name) {
            throw Error('聊天或绑定世界书已变化，本次操作已停止。');
        }
    } };
}

export async function installUnifiedWorldbook({ getContext, fetcher = globalThis.fetch, loadModule = () => import('/scripts/world-info.js') }) {
    const { ctx, name, guard } = captureBook(getContext);
    if (installing.has(name)) throw Error('正在处理此世界书，请稍后重试。');
    installing.add(name);
    try {
        const request = requestApi(ctx, fetcher), wi = await loadModule(); guard();
        if (typeof wi.createWorldInfoEntry !== 'function') throw Error('当前酒馆缺少世界书条目创建接口，未修改。');
        const original = await request('get', { name }); guard();
        const cached = wi.worldInfoCache?.get(name);
        if (cached && !same(cached, original)) throw Error('世界书编辑器有尚未同步的修改，请保存并关闭编辑器后重试。');
        const prepared = prepareUnifiedWorldbook(original, name, wi.createWorldInfoEntry);
        if (!prepared.changed) return { name, uid: prepared.entry.uid, action: '已存在，无需重复写入', message: prepared.entry.disable ? '统一条目已存在，但已在世界书中禁用；请按需手动启用。' : '统一条目已存在，已保留位置、触发设置和自定义规则。', warning: '' };
        const latest = await request('get', { name }); guard();
        const currentCache = wi.worldInfoCache?.get(name);
        if (!same(latest, original) || currentCache && !same(currentCache, original)) throw Error('世界书刚被其他操作修改，本次未覆盖，请重试。');
        try { await request('edit', { name, data: prepared.book }); }
        catch (error) { throw Error('统一条目保存结果未确认，请检查世界书后重试：' + error.message); }
        // Only the inert template is cached; runtime expansion never reaches here.
        wi.worldInfoCache?.set(name, clone(prepared.book));
        let warning = '';
        try {
            const verified = await request('get', { name });
            if (!same(verified, prepared.book)) warning = '保存请求已完成，但读回内容不同，请检查世界书条目。';
        } catch { warning = '保存请求已完成，但读回校验失败，请检查世界书条目。'; }
        const events = ctx.eventTypes ?? ctx.event_types ?? {};
        try { if (events.WORLDINFO_UPDATED) await ctx.eventSource?.emit?.(events.WORLDINFO_UPDATED, name, clone(prepared.book)); }
        catch { warning += ' 请重新打开世界书刷新界面。'; }
        return { name, uid: prepared.entry.uid, action: '已新增', message: '已写入统一条目模板；当前聊天资料仅在本轮生成时展开。', warning };
    } finally { installing.delete(name); }
}

export async function inspectUnifiedWorldbook({ getContext, fetcher = globalThis.fetch }) {
    const { ctx, name, guard } = captureBook(getContext);
    const book = await requestApi(ctx, fetcher)('get', { name }); guard();
    const entry = ownedEntries(book)[0], valid = !!entry && hasUnifiedPlaceholder(entry.content);
    return {
        name, exists: !!entry, uid: entry?.uid ?? null, enabled: !!entry && !entry.disable, valid, content: entry?.content ?? '',
        message: !entry ? '尚未写入统一条目' : !valid ? `条目需要保留一个 ${LINKAGE_PLACEHOLDER} 占位` : entry.disable ? '统一条目已在世界书中禁用' : '统一条目已就绪；是否实际插入仍遵循酒馆世界书和预设设置',
    };
}
