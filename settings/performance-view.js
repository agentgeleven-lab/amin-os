import { performanceDiagnostics } from '../apps/shared/performance-diagnostics.js';

export function mountPerformanceDiagnostics(target, { diagnostics = performanceDiagnostics, document = target.ownerDocument ?? globalThis.document } = {}) {
    const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
    const box = make('section', '', 'amin-card amin-stack'), status = make('p', '', 'amin-meta'), rows = make('div', '', 'amin-stack'), toolbar = make('div', '', 'amin-toolbar');
    box.append(make('h3', 'Amin 性能诊断', 'amin-section-heading'),
        make('p', '按需测量 Amin 触发的恢复、保存与文件读写。开始后进行一次聊天或分支操作，再停止并查看结果。记录只在当前页面内存中。', 'amin-meta'), status, toolbar, rows,
        make('p', '耗时包含宿主接口等待，各项可能互相包含，不能相加当成总卡顿时间。写入量为成功提交的 JSON 大小估算，不代表同步传输量、磁盘实际占用或整个酒馆的性能。', 'amin-meta'));
    const button = (label, fn) => { const node = make('button', label); node.type = 'button'; node.onclick = () => { fn(); render(); }; toolbar.append(node); return node; };
    const start = button('开始测量', () => diagnostics.start()), stop = button('停止测量', () => diagnostics.stop());
    button('刷新结果', () => {}); button('清空结果', () => diagnostics.reset());
    function render() {
        const snapshot = diagnostics.snapshot(); start.disabled = snapshot.enabled; stop.disabled = !snapshot.enabled;
        status.textContent = snapshot.enabled ? '正在测量；刷新结果查看本次数据。' : '未在测量；结果保留到清空或刷新页面。';
        rows.textContent = '';
        if (!snapshot.rows.length) rows.append(make('p', '尚无测量记录。', 'amin-empty'));
        for (const row of snapshot.rows) {
            const card = make('div', '', 'amin-card');
            card.append(make('strong', row.label), make('p', `${row.count} 次 · 失败 ${row.failures} 次 · 平均 ${(row.totalMs / row.count).toFixed(1)} ms · 最近样本 P95 ${row.p95Ms.toFixed(1)} ms · 最大 ${row.maxMs.toFixed(1)} ms`));
            if (row.kind === 'fileWrite') card.append(make('p', `本次累计提交约 ${(row.bytes / 1024).toFixed(1)} KiB JSON`));
            rows.append(card);
        }
    }
    target.append(box); render();
    return { refresh: render, dispose() { box.remove(); } };
}
