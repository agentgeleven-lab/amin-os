import { LIMITS, normalizeConfig, rollBatch, formatRoll } from './engine.js';
export const SETTINGS_KEY = 'amin_os_dice_presets_v1';
export const HISTORY_KEY = 'amin_os_dice_v1';
const clone = value => structuredClone(value);
export function createRollId(cryptoSource = globalThis.crypto) {
    if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
    // randomUUID is unavailable on some HTTP LAN/mobile hosts where getRandomValues works.
    if (typeof cryptoSource?.getRandomValues !== 'function') throw Error('当前浏览器不支持安全随机数标识。');
    const bytes = new Uint8Array(16); cryptoSource.getRandomValues(bytes); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
const chatKey = c => JSON.stringify([c?.getCurrentChatId?.() ?? c?.chatId ?? null, c?.characterId ?? null, c?.groupId ?? null]);
const loaded = c => c?.chatMetadata && typeof c.chatMetadata === 'object' && (c.getCurrentChatId?.() ?? c.chatId) != null && (c.getCurrentChatId?.() ?? c.chatId) !== '';
const validRecord = r => r && typeof r.id === 'string' && typeof r.text === 'string' && Array.isArray(r.results) && r.settings && Number.isFinite(r.createdAt);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function compatibleHistoryRecord(record) {
    if (!validRecord(record) || !record.id || !record.text || !object(record.settings) || !record.results.length || !record.results.every(r => object(r) && Number.isFinite(r.total))) return false;
    if (record.status !== undefined && !['rolled', 'appended', 'sent'].includes(record.status)) return false;
    try { normalizeConfig(record.settings); return true; } catch { return false; }
}
function compatiblePreset(preset) {
    if (!object(preset) || typeof preset.id !== 'string' || !preset.id || typeof preset.name !== 'string' || !preset.name.trim() || !object(preset.settings)) return false;
    try { normalizeConfig(preset.settings); return true; } catch { return false; }
}
// Read views may skip damaged records, but no write may use that filtered view to
// replace unrecognized source data. Missing version is the compatible legacy shape.
function assertWritableStore(raw, listKey, validate, label) {
    if (raw === undefined) return;
    if (!object(raw) || raw.version !== undefined && raw.version !== 1) throw Error(label + '版本不兼容，原始数据已保留，未写入。');
    if (!Array.isArray(raw[listKey]) || !raw[listKey].every(validate) || new Set(raw[listKey].map(r => r.id)).size !== raw[listKey].length) throw Error(label + '包含无法识别或损坏的记录，原始数据已保留，未写入。');
}
const assertHistoryWritable = ctx => assertWritableStore(ctx?.chatMetadata?.[HISTORY_KEY], 'rolls', compatibleHistoryRecord, '骰点历史');
const assertPresetsWritable = ctx => assertWritableStore(ctx?.extensionSettings?.[SETTINGS_KEY], 'presets', compatiblePreset, '骰子预设');
export function readHistory(ctx) { return (Array.isArray(ctx?.chatMetadata?.[HISTORY_KEY]?.rolls) ? ctx.chatMetadata[HISTORY_KEY].rolls : []).filter(validRecord).map(clone); }
export function readPresets(ctx) {
    const result = [];
    for (const p of Array.isArray(ctx?.extensionSettings?.[SETTINGS_KEY]?.presets) ? ctx.extensionSettings[SETTINGS_KEY].presets : []) {
        try { if (typeof p?.id === 'string' && typeof p.name === 'string' && p.name.trim() && !result.some(v => v.id === p.id)) result.push({ id: p.id, name: p.name.slice(0, 60), settings: normalizeConfig(p.settings) }); } catch { /* Ignore corrupt external settings without mutating them. */ }
    }
    return result;
}
export function appendText(existing, addition) { return existing ? `${existing}${existing.endsWith('\n') ? '' : '\n'}${addition}` : addition; }
function emitInput(input) { const EventType = input.ownerDocument?.defaultView?.Event ?? globalThis.Event; input.dispatchEvent?.(new EventType('input', { bubbles: true })); }
export function appendToDraft({ input, text, expectedDraft, check }) {
    check();
    if (!input || typeof input.value !== 'string' || input.disabled || input.readOnly || input.isConnected === false) throw Error('聊天输入框当前不可编辑。');
    if (input.value !== expectedDraft) throw Error('草稿已改变，请检查当前内容后再次追加。');
    if (input.value.includes(text)) throw Error('这次骰点已经在草稿中。');
    const before = input.value, after = appendText(before, text); input.value = after;
    emitInput(input); input.focus?.(); return { input, before, after };
}
export function createDiceService(getContext = () => globalThis.SillyTavern?.getContext?.(), { rng, createId = createRollId, now = Date.now } = {}) {
    const listeners = new Set(), dirty = new WeakSet(), subscriptions = [], pending = new Map();
    let busy = false, settingsBusy = false, disposed = false, lastAppend = null, message = '先掷骰，再把固定结果追加到聊天草稿。';
    const notify = () => { for (const fn of listeners) fn(); };
    function capture() {
        const ctx = getContext(); if (!loaded(ctx)) throw Error('请先打开一个聊天，再掷骰。');
        return { key: chatKey(ctx), metadata: ctx.chatMetadata };
    }
    function check(token) { const c = getContext(); if (!loaded(c) || token.key !== chatKey(c) || token.metadata !== c.chatMetadata) throw Error('聊天已变化，请在当前聊天重新选择骰点。'); return c; }
    function restorePending() {
        let token, c; try { token = capture(); c = check(token); } catch { return; }
        for (const r of readHistory(c)) if (r.status === 'appended' && r.pending?.chatKey === token.key && Number.isSafeInteger(r.pending.firstIndex) && r.pending.firstIndex >= 0 && r.pending.firstIndex <= (c.chat?.length ?? 0)) {
            pending.set(r.id, { token, text: r.text, firstIndex: r.pending.firstIndex });
        }
    }
    function history() {
        const c = getContext(); if (!loaded(c)) return [];
        return readHistory(c).map(r => ({ ...r, linked: !!r.sent && c.chat?.[r.sent.messageIndex]?.is_user === true && c.chat[r.sent.messageIndex].mes === r.sent.messageText }));
    }
    function write(ctx, records) { assertHistoryWritable(ctx); ctx.chatMetadata[HISTORY_KEY] = { ...ctx.chatMetadata[HISTORY_KEY], version: 1, rolls: records }; dirty.add(ctx.chatMetadata); }
    async function persist(ctx, token) {
        check(token); assertHistoryWritable(ctx);
        if (typeof ctx.saveMetadata !== 'function') throw Error('当前酒馆缺少聊天保存接口；骰点仍保留在本聊天内存中。');
        const value = ctx.chatMetadata[HISTORY_KEY];
        try { await ctx.saveMetadata(); if (ctx.chatMetadata[HISTORY_KEY] === value) dirty.delete(ctx.chatMetadata); }
        catch (e) { throw Error(`骰点已固定，但聊天保存失败：${e?.message || '未知错误'}。请重试保存。`); }
    }
    async function roll(input, rerollOf = null) {
        if (busy) throw Error('正在处理骰点，请稍候。');
        const token = capture(), c = check(token), settings = normalizeConfig(input);
        assertHistoryWritable(c);
        if (typeof c.saveMetadata !== 'function') throw Error('当前酒馆缺少聊天保存接口，无法建立骰点记录。');
        const id = createId(), result = rollBatch(settings, rng), record = { id, createdAt: now(), settings: result.settings, results: result.results, status: 'rolled', rerollOf };
        record.text = formatRoll(record); busy = true;
        // Keep the random result on persistence failure. Retry-save never rolls again.
        write(c, [...readHistory(c), record]); message = '骰点已固定，正在保存。'; notify();
        try { await persist(c, token); check(token); message = '骰点已固定。追加到草稿后，可与行动正文一起发送。'; return clone(record); }
        catch (e) { message = e.message; throw e; }
        finally { busy = false; notify(); }
    }
    async function retrySave() {
        if (busy) throw Error('正在保存，请稍候。'); const token = capture(), c = check(token); busy = true;
        try { await persist(c, token); check(token); message = '骰点记录已保存。'; } catch (e) { message = e.message; throw e; } finally { busy = false; notify(); }
    }
    async function append(ids, input = globalThis.document?.querySelector('#send_textarea')) {
        if (busy) throw Error('正在处理骰点，请稍候。');
        const token = capture(), c = check(token), expectedDraft = input?.value, selectedIds = [...new Set(Array.isArray(ids) ? ids : [ids])];
        assertHistoryWritable(c);
        let list = readHistory(c), selected = selectedIds.map(id => list.find(r => r.id === id));
        if (!selected.length || selected.some(r => !r)) throw Error('骰点记录已不存在，请重新选择。');
        if (selected.some(r => r.status === 'sent')) throw Error('所选骰点已发出；需要新判定时请明确重掷。');
        busy = true;
        try {
            if (dirty.has(c.chatMetadata)) await persist(c, token);
            check(token); assertHistoryWritable(c);
            // A send event can change other records while retry-save is pending.
            // Merge into the latest snapshot instead of writing back the pre-await list.
            list = readHistory(c); selected = selectedIds.map(id => list.find(r => r.id === id));
            if (selected.some(r => !r)) throw Error('骰点记录已不存在，请重新选择。');
            if (selected.some(r => r.status === 'sent')) throw Error('所选骰点已发出；需要新判定时请明确重掷。');
            const text = selected.map(r => r.text).join('\n\n');
            if (selected.some(r => String(input?.value ?? '').includes(r.text))) throw Error('所选骰点已经在草稿中，请选择其他记录。');
            const appendInfo = appendToDraft({ input, text, expectedDraft, check: () => check(token) });
            lastAppend = { ...appendInfo, token, ids: selected.map(r => r.id) };
            for (const r of selected) { const target = list.find(v => v.id === r.id); target.status = 'appended'; target.pending = { chatKey: token.key, firstIndex: c.chat?.length ?? 0 }; pending.set(r.id, { token, text: r.text, firstIndex: target.pending.firstIndex }); }
            write(c, list); message = '已追加固定骰点。继续编辑行动正文，然后使用聊天发送按钮一起发出。'; notify();
            await persist(c, token); check(token);
        } catch (e) { message = e.message; throw e; } finally { busy = false; notify(); }
    }
    async function undoAppend() {
        if (busy) throw Error('正在处理骰点，请稍候。');
        const undo = lastAppend; if (!undo) throw Error('没有可撤销的追加。'); const c = check(undo.token);
        assertHistoryWritable(c);
        if (undo.input.value !== undo.after) throw Error('你已编辑草稿，无法自动撤销；请手动移除骰点段落。');
        if (undo.ids.some(id => !pending.has(id))) throw Error('骰点可能已经发送，无法撤销。');
        const list = readHistory(c); undo.input.value = undo.before; emitInput(undo.input); lastAppend = null;
        for (const r of list) if (undo.ids.includes(r.id)) { r.status = 'rolled'; delete r.pending; pending.delete(r.id); }
        write(c, list); busy = true;
        try { await persist(c, undo.token); message = '已撤销刚才的追加，骰点记录仍然保留。'; } catch (e) { message = e.message; throw e; } finally { busy = false; notify(); }
    }
    async function savePreset(name, settings, id = null) {
        if (settingsBusy) throw Error('正在保存预设，请稍候。');
        const c = getContext(), title = String(name ?? '').trim();
        if (!title || title.length > 60) throw Error('预设名称需为 1–60 字。');
        if (!c?.extensionSettings || typeof c.saveSettingsDebounced !== 'function') throw Error('当前酒馆缺少预设保存接口。');
        assertPresetsWritable(c);
        const presets = clone(c.extensionSettings[SETTINGS_KEY]?.presets ?? []), item = { id: id || createId(), name: title, settings: normalizeConfig(settings) };
        if (presets.some(p => p.id !== item.id && p.name === title)) throw Error('已有同名预设，请换一个名称。');
        const index = presets.findIndex(p => p.id === item.id); if (index < 0) { if (presets.length >= LIMITS.presets) throw Error(`最多保存 ${LIMITS.presets} 个预设。`); presets.push(item); } else presets[index] = { ...presets[index], ...item, settings: { ...presets[index].settings, ...item.settings } };
        const before = c.extensionSettings[SETTINGS_KEY], next = { ...before, version: 1, presets }; c.extensionSettings[SETTINGS_KEY] = next; settingsBusy = true;
        try { await c.saveSettingsDebounced(); message = '预设已保存，可在所有聊天中使用。'; return clone(item); }
        catch (e) { if (c.extensionSettings[SETTINGS_KEY] === next) { if (before === undefined) delete c.extensionSettings[SETTINGS_KEY]; else c.extensionSettings[SETTINGS_KEY] = before; } throw Error(`预设保存失败：${e.message}`); }
        finally { settingsBusy = false; notify(); }
    }
    async function deletePreset(id) {
        if (settingsBusy) throw Error('正在保存预设，请稍候。'); const c = getContext();
        if (!c?.extensionSettings || typeof c.saveSettingsDebounced !== 'function') throw Error('当前酒馆缺少预设保存接口。');
        assertPresetsWritable(c);
        const before = c.extensionSettings[SETTINGS_KEY], next = { ...before, version: 1, presets: clone(before?.presets ?? []).filter(p => p.id !== id) }; c.extensionSettings[SETTINGS_KEY] = next; settingsBusy = true;
        try { await c.saveSettingsDebounced(); message = '预设已删除。'; } catch (e) { if (c.extensionSettings[SETTINGS_KEY] === next) { if (before === undefined) delete c.extensionSettings[SETTINGS_KEY]; else c.extensionSettings[SETTINGS_KEY] = before; } throw Error(`预设删除失败：${e.message}`); } finally { settingsBusy = false; notify(); }
    }
    function onSent(index) {
        if (disposed) return; restorePending(); if (!pending.size) return;
        let token, c; try { token = capture(); c = check(token); } catch { return; }
        try { assertHistoryWritable(c); } catch (e) { message = e.message; notify(); return; }
        const list = readHistory(c); let changed = false;
        for (const [id, p] of pending) {
            if (p.token.key !== token.key || p.token.metadata !== token.metadata) continue;
            const numeric = typeof index === 'number' || typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : null;
            const candidates = (c.chat ?? []).map((m, i) => ({ m, i })).filter(({ m, i }) => i >= p.firstIndex && (numeric === null || numeric === i) && m?.is_user === true && typeof m.mes === 'string' && m.mes.includes(p.text));
            // An event alone is insufficient; require exactly one new matching user message.
            if (candidates.length !== 1) continue;
            const record = list.find(r => r.id === id); if (!record) { pending.delete(id); continue; }
            const { m, i } = candidates[0]; record.status = 'sent'; record.sent = { messageIndex: i, messageText: m.mes, at: now() }; delete record.pending; pending.delete(id); changed = true;
        }
        if (!changed) return;
        write(c, list); lastAppend = null; message = '骰点已随用户消息发送；重试或续写会沿用消息中的固定结果。'; notify();
        // Host callbacks must not throw. The record survives a failed save for explicit retry.
        void persist(c, token).catch(e => { message = e.message; notify(); });
    }
    function onChatChange() { pending.clear(); lastAppend = null; restorePending(); message = '已切换聊天。此处只显示当前聊天的骰点记录。'; notify(); }
    const initial = getContext(), source = initial?.eventSource, events = initial?.eventTypes ?? initial?.event_types ?? {};
    for (const [name, fn] of Object.entries({ MESSAGE_SENT: onSent, CHAT_CHANGED: onChatChange, MESSAGE_DELETED: notify, MESSAGE_UPDATED: notify, MESSAGE_SWIPED: notify })) {
        if (!events[name] || !source?.on) continue; source.on(events[name], fn); subscriptions.push(() => source.removeListener ? source.removeListener(events[name], fn) : source.off?.(events[name], fn));
    }
    return { capture, check, history, roll, append, undoAppend, retrySave, savePreset, deletePreset, presets: () => readPresets(getContext()), context: getContext,
        reroll(id) { const record = history().find(r => r.id === id); if (!record) throw Error('骰点记录已不存在。'); return roll(record.settings, id); },
        status: () => message, busy: () => busy || settingsBusy, dirty: () => dirty.has(getContext()?.chatMetadata ?? {}), canUndo: () => !!lastAppend,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        dispose() { disposed = true; for (const remove of subscriptions) remove(); listeners.clear(); pending.clear(); lastAppend = null; },
    };
}
let shared;
export function getSharedDiceService(getContext) { return shared ??= createDiceService(getContext); }
