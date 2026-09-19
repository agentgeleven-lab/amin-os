// 存储层：注入 storage（getItem/setItem/removeItem），按聊天命名空间隔离，
// 不写入 extensionSettings / chatMetadata，与角色数据互不接触。
import { normalizeCampaign } from './model.js';
import { applyUpdate } from './rules.js';
import { followProtocol, parseUpdate } from './ai.js';
export const KEY = 'amin_os_factions_v1';
export const PROMPT_KEY = 'amin-os-factions-follow';
export const emptyStore = () => ({ version: 1, campaigns: [], activeId: '', follow: false });

export function createFactions({ storage, getContext }) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw Error('势力沙盘需要可用的本地存储');
    const listeners = new Set();
    let message = '势均力敌，也要有人记账。', pending = null, scanStamp = '', cacheKey = null, store = emptyStore();
    const notify = text => { if (text != null) message = text; listeners.forEach(fn => fn()); };
    const chatKey = c => {
        const id = c?.getCurrentChatId?.();
        if (id == null || id === '') throw Error('请先打开一个聊天');
        const avatar = c.groupId == null || c.groupId === '' ? (c.characters?.[c.characterId]?.avatar ?? '') : '';
        return [String(c.groupId ?? ''), avatar, String(id)].join('|');
    };
    const readStore = key => {
        let raw = null;
        try { raw = JSON.parse(storage.getItem(key) ?? ''); } catch { return emptyStore(); }
        if (!raw || raw.version !== 1 || !Array.isArray(raw.campaigns)) return emptyStore();
        const campaigns = [];
        for (const item of raw.campaigns) { try { campaigns.push(normalizeCampaign(item)); } catch { /* 跳过损坏棋局 */ } }
        return { version: 1, campaigns, activeId: campaigns.some(c => c.id === raw.activeId) ? raw.activeId : (campaigns[0]?.id ?? ''), follow: !!raw.follow };
    };
    const persist = () => storage.setItem(cacheKey, JSON.stringify(store));
    const load = () => {
        const key = KEY + ':' + chatKey(getContext());
        if (key !== cacheKey) { cacheKey = key; store = readStore(key); }
        return store;
    };
    const api = {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        status: () => message,
        context: getContext,
        snapshot() { const s = load(); return { names: s.campaigns.map(c => ({ id: c.id, name: c.name, scale: c.scaleTemplate })), activeId: s.activeId, follow: s.follow }; },
        active() { const s = load(); return s.campaigns.find(c => c.id === s.activeId) ?? null; },
        campaign(id) { const s = load(); return s.campaigns.find(c => c.id === id) ?? null; },
        saveCampaign(campaign) {
            const s = load(), next = normalizeCampaign(campaign);
            const index = s.campaigns.findIndex(c => c.id === next.id);
            if (index >= 0) s.campaigns[index] = next; else s.campaigns.push(next);
            s.activeId = next.id; persist(); notify('沙盘已保存'); return next;
        },
        deleteCampaign(id) { const s = load(); s.campaigns = s.campaigns.filter(c => c.id !== id); if (s.activeId === id) s.activeId = s.campaigns[0]?.id ?? ''; persist(); notify('棋局已删除'); },
        setActive(id) { const s = load(); if (!s.campaigns.some(c => c.id === id)) throw Error('棋局不存在'); s.activeId = id; persist(); notify(null); },
        setFollow(value) { const s = load(); s.follow = !!value; persist(); notify(value ? '已开启增量跟随：下一轮生成将附带沙盘协议' : '已关闭增量跟随'); },
        pending: () => pending,
        dropPending() { pending = null; notify('已忽略待确认变更'); },
        // 试算待确认变更：不落盘，供预览层展示。
        previewPending() {
            if (!pending) return null;
            const campaign = api.active();
            if (!campaign) { pending = null; return null; }
            return { ...applyUpdate(campaign, pending.update), at: pending.at };
        },
        // 确认后才写入存储。
        confirmPending() {
            if (!pending) throw Error('没有待确认的变更');
            const campaign = api.active();
            if (!campaign) { pending = null; throw Error('当前聊天没有棋局，变更已丢弃'); }
            const result = applyUpdate(campaign, pending.update);
            api.saveCampaign(result.campaign);
            pending = null; notify('已应用 AI 沙盘变更'); return result;
        },
        // 扫描一条 AI 回复：解析出隐藏块则挂起待确认变更，绝不直接写盘。
        scanMessage(mes) {
            if (typeof mes !== 'string' || !mes.includes('[FACTION_UPDATE]')) return null;
            const { update, reason } = parseUpdate(mes);
            if (!update) { if (reason === 'invalid') notify('AI 回复的势力变更块不是合法 JSON，已忽略'); return null; }
            const s = load();
            if (!s.campaigns.length) return null;
            pending = { update, at: new Date().toISOString() };
            notify('AI 回复包含势力变更，待确认');
            return pending;
        },
        reset() { cacheKey = null; pending = null; scanStamp = ''; clearPrompt(); },
    };
    function clearPrompt() { try { getContext()?.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false); } catch { } }
    function injectPrompt() {
        try {
            const s = load();
            const campaign = s.campaigns.find(c => c.id === s.activeId);
            const ctx = getContext();
            if (s.follow && campaign && ctx?.setExtensionPrompt) ctx.setExtensionPrompt(PROMPT_KEY, followProtocol(campaign), 1, 0, false);
            else clearPrompt();
        } catch (e) { notify('势力沙盘协议注入失败：' + e.message); }
    }
    function scanLatest() {
        try {
            const ctx = getContext();
            const chat = ctx?.chat ?? [];
            const message = [...chat].reverse().find(m => !m.is_user && !m.is_system && typeof m.mes === 'string');
            if (!message) return;
            const stamp = JSON.stringify([chatKey(ctx), chat.length, message.mes.length]);
            if (stamp === scanStamp) return;
            scanStamp = stamp;
            api.scanMessage(message.mes);
        } catch { /* 聊天未就绪时静默 */ }
    }
    const ctx = getContext(), events = ctx?.eventTypes ?? ctx?.event_types ?? {}, source = ctx?.eventSource;
    const supported = !!(source?.on && events.CHAT_CHANGED);
    const handlers = {
        GENERATION_AFTER_COMMANDS: () => injectPrompt(),
        MESSAGE_RECEIVED: scanLatest,
        MESSAGE_UPDATED: scanLatest,
        GENERATION_ENDED: () => { clearPrompt(); },
        CHAT_CHANGED: () => { api.reset(); notify('已切换聊天'); },
    };
    if (supported) for (const [name, fn] of Object.entries(handlers)) if (events[name]) source.on(events[name], fn);
    return { ...api, supported, dispose() { clearPrompt(); if (supported) for (const [name, fn] of Object.entries(handlers)) if (events[name]) source?.removeListener?.(events[name], fn); } };
}

let shared;
export const getSharedFactions = () => shared ??= createFactions({ storage: globalThis.localStorage, getContext: () => globalThis.SillyTavern?.getContext?.() });
