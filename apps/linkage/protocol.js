import { MODULES, plain, validateJSON } from './policy.js';

export const OPEN = '<amin_update>', CLOSE = '</amin_update>';
export function parseUpdate(input) {
    let raw = input;
    if (typeof input === 'string') {
        if (input.length > 2 * 1024 * 1024) throw Error('一次联动更新超过 2 MiB。');
        const starts = input.split(OPEN).length - 1, ends = input.split(CLOSE).length - 1;
        if (starts || ends) {
            if (starts !== 1 || ends !== 1 || input.indexOf(CLOSE) < input.indexOf(OPEN)) throw Error('每条消息必须只有一个完整的 amin_update 更新块。');
            raw = input.slice(input.indexOf(OPEN) + OPEN.length, input.indexOf(CLOSE));
        }
        try { raw = JSON.parse(raw); } catch { throw Error('联动更新不是有效 JSON，请检查模型输出。'); }
    }
    validateJSON(raw);
    if (!plain(raw) || raw.version !== 1 || Object.keys(raw).some(k => !['version','changes'].includes(k)) || !Array.isArray(raw.changes) || raw.changes.length > 64) throw Error('联动更新必须使用 version:1 和最多 64 项 changes。');
    for (const change of raw.changes) {
        if (!plain(change) || Object.keys(change).some(k => !['module','action','target','data','reason'].includes(k)) || !Object.hasOwn(MODULES, change.module)) throw Error('更新包含未知模块或字段。');
        if (typeof change.action !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(change.action) || !plain(change.data)) throw Error('更新 action 或 data 格式无效。');
        if (change.target !== undefined && (typeof change.target !== 'string' || !change.target || change.target.length > 300)) throw Error('更新 target 必须是已有对象标识或明确的新对象标识。');
        if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 2000) throw Error('每项更新必须说明已经发生的剧情依据（最多 2000 字）。');
    }
    return structuredClone(raw);
}
export function hasUpdate(text) { return typeof text === 'string' && (text.includes(OPEN) || text.includes(CLOSE)); }
