// Opt-in, memory-only instrumentation. Never records names, messages or paths.
export const PERFORMANCE_LABELS = Object.freeze({
    restore: '恢复剧情状态', prepare: '保存前准备', chatSave: '宿主聊天保存', metadataSave: '宿主元数据保存',
    fileRead: '剧情文件读取', fileWrite: '剧情文件写入',
});
const noop = () => {};
export function createPerformanceDiagnostics({ now = () => globalThis.performance?.now?.() ?? Date.now(), maxSamples = 128 } = {}) {
    let enabled = false, epoch = 0, started = null;
    const rows = new Map();
    const reset = () => { epoch++; rows.clear(); started = enabled ? now() : null; };
    return {
        enabled: () => enabled,
        start() { enabled = true; reset(); },
        stop() { enabled = false; epoch++; },
        reset,
        begin(kind) {
            if (!enabled || !Object.hasOwn(PERFORMANCE_LABELS, kind)) return noop;
            const start = now(), ticket = epoch; let finished = false;
            return ({ failed = false, bytes = 0 } = {}) => {
                if (finished || !enabled || ticket !== epoch) return;
                finished = true;
                const ms = Math.max(0, now() - start), row = rows.get(kind) ?? { kind, count: 0, failures: 0, totalMs: 0, maxMs: 0, bytes: 0, samples: [] };
                row.count++; row.failures += Number(!!failed); row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
                row.bytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
                row.samples.push(ms); if (row.samples.length > maxSamples) row.samples.shift();
                rows.set(kind, row);
            };
        },
        snapshot() {
            return { enabled, started, rows: [...rows.values()].map(row => {
                const values = [...row.samples].sort((a, b) => a - b);
                return { kind: row.kind, label: PERFORMANCE_LABELS[row.kind], count: row.count, failures: row.failures,
                    totalMs: row.totalMs, maxMs: row.maxMs, bytes: row.bytes,
                    p95Ms: values[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0, sampleCount: values.length };
            }) };
        },
    };
}
export const performanceDiagnostics = createPerformanceDiagnostics();
