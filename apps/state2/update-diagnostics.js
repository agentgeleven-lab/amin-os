import { sha256HexSync } from '../tts/source-hash.js';

const clip = (value, limit = 240) => String(value ?? '').slice(0, limit);
const sensitive = /(?:api[_-]?key|authorization|password|secret|access[_-]?token)/iu;
const safeError = value => clip(String(value?.message ?? value ?? '')
    .replace(/Bearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(/(?:sk-|AIza)[\w-]{8,}/gu, '[已隐藏]')
    .replace(/((?:api[_-]?key|password|secret|token)\s*[:=]\s*)\S+/giu, '$1[已隐藏]'));

/** Session-only, bounded diagnostics. Never writes metadata or executes model text. */
export function createUpdateDiagnostics({ roots = [], maxRecords = 12, now = () => Date.now() } = {}) {
    const allowed = [...new Set(roots.filter(root => typeof root === 'string'))].slice(0, 24);
    const limit = Math.max(1, Math.min(24, Number(maxRecords) || 12));
    let pending = null, history = [], sequence = 0;
    function snapshot(variables = {}) {
        const leaves = new Map(), skippedRoots = [];
        let budget = 1200;
        for (const root of allowed) {
            if (!Object.hasOwn(variables, root)) continue;
            let value = variables[root];
            if (typeof value === 'string') {
                if (value.length > 300000) { skippedRoots.push(root); continue; }
                try { value = JSON.parse(value); } catch { /* Native scalar. */ }
            }
            function walk(item, path, depth) {
                if (--budget < 0) { skippedRoots.push(root); return; }
                if (sensitive.test(path.at(-1))) return;
                if (item && typeof item === 'object' && depth < 8) {
                    const keys = Object.keys(item);
                    if (keys.length) { for (const key of keys.slice(0, 1200)) walk(item[key], [...path, key], depth + 1); return; }
                }
                if (item && typeof item === 'object' && depth >= 8) { skippedRoots.push(root); return; }
                let raw;
                try { raw = JSON.stringify(item); } catch { raw = '[无法读取]'; }
                if ((raw?.length ?? 0) > 300000) { skippedRoots.push(root); return; }
                leaves.set(JSON.stringify(path), { path: clip(path.join('.'), 240), hash: sha256HexSync(raw ?? 'undefined'), value: clip(raw ?? 'undefined') });
            }
            walk(value, [root], 0);
        }
        return { leaves, skipped: new Set(skippedRoots), limited: budget < 0 || skippedRoots.length > 0 };
    }
    function begin({ variables, index, swipe, source = 'generation' } = {}) {
        pending = { snapshot: snapshot(variables), index, swipe, source };
    }
    function finish({ variables, receivedState = false, errors = [], index, swipe, source } = {}) {
        const before = pending, after = snapshot(variables); pending = null;
        const changes = [];
        let omitted = 0;
        if (before) for (const key of new Set([...before.snapshot.leaves.keys(), ...after.leaves.keys()])) {
            const root = JSON.parse(key)[0];
            if (before.snapshot.skipped.has(root) || after.skipped.has(root)) continue;
            const left = before.snapshot.leaves.get(key), right = after.leaves.get(key);
            if (left?.hash === right?.hash) continue;
            if (changes.length >= 40) { omitted++; continue; }
            changes.push({ path: (right ?? left).path, before: left?.value ?? '（不存在）', after: right?.value ?? '（已删除）' });
        }
        const nativeErrors = (Array.isArray(errors) ? errors : [errors]).filter(Boolean).slice(0, 5).map(safeError);
        const warnings = [];
        if (!before) warnings.push('未取得本轮更新前的变量，无法比较变更。');
        if (before?.snapshot.limited || after.limited || omitted) warnings.push('资料较大，仅显示有界采样的变更，未列出的字段不代表未变化。');
        const record = { id: ++sequence, at: now(), index: Number.isInteger(index ?? before?.index) ? index ?? before.index : null,
            swipe: Number.isInteger(swipe ?? before?.swipe) ? swipe ?? before.swipe : null,
            source: clip(source ?? before?.source ?? 'unknown', 40), receivedState: receivedState === true,
            outcome: nativeErrors.length ? 'native-error' : !before ? 'unknown' : changes.length ? 'changed' : before.snapshot.limited || after.limited ? 'unknown' : receivedState ? 'state-without-change' : 'no-state',
            changes, errors: nativeErrors, warnings, omitted };
        history.unshift(record); history.length = Math.min(history.length, limit);
        return structuredClone(record);
    }
    return { begin, finish, records: () => structuredClone(history), clear() { pending = null; history = []; } };
}
