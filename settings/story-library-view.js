import { getState2Runtime } from '../apps/state2/runtime.js';

const size = bytes => {
    const value = Number.isFinite(bytes) ? bytes : 0;
    return value >= 1048576 ? `${(value / 1048576).toFixed(2)} MiB`
        : value >= 1024 ? `${(value / 1024).toFixed(2)} KiB` : `${value} B`;
};

/** Global analysis is read-only. Scan results stay in this mounted view, never in chat metadata. */
export function mountStoryLibrary(target, { getRuntime = getState2Runtime, report = () => {}, document = target.ownerDocument ?? globalThis.document } = {}) {
    let disposed = false, generation = 0, controller = null, result = null, previewOpen = false, exporting = false;
    const pages = { chat: 0, backup: 0, candidates: 0 }, expanded = { chat: false, backup: false, issues: false }, pageSize = 25;
    const make = (tag, text = '', className = '') => {
        const node = document.createElement(tag); node.textContent = text;
        if (className) node.className = className;
        if (node.style) { node.style.minWidth = '0'; node.style.overflowWrap = 'anywhere'; }
        return node;
    };
    const box = make('section', '', 'amin-card amin-stack');
    const status = make('p', '尚未扫描；仅在点击后读取宿主可枚举范围内的引用。', 'amin-meta');
    const controls = make('div', '', 'amin-toolbar'), results = make('div', '', 'amin-stack');
    const button = (label, action, target = controls) => {
        const node = make('button', label); node.type = 'button'; node.onclick = action; target.append(node); return node;
    };
    const scan = button('扫描全库剧情文件', () => void runScan());
    const cancel = button('取消扫描', () => {
        generation++; controller?.abort(); controller = null;
        status.textContent = '操作已取消；未修改文件。'; exporting = false;
        setBusy(false); render();
    });
    cancel.disabled = true;
    box.append(make('h3', '全库剧情存储分析', 'amin-section-heading'),
        make('p', '按需读取宿主可枚举的聊天、Swipe、分支及备份引用，分析 Amin 外置文件。宿主列表可能不包含已删除角色留下的聊天目录。报告仅保留在当前页面，不写入聊天。', 'amin-meta'),
        status, controls, results,
        make('p', '外置文件大小为 JSON 内容估算，和聊天／备份文档分开计算。文档大小是宿主返回内容的逻辑字节数（备份已解压），不代表磁盘实际占用或同步传输量，也不包含图片等其他资源。各聊天可能共享外置文件，不能把各行关联文件大小相加当成全库总量。', 'amin-meta'));
    target.append(box);

    function setBusy(busy) { scan.disabled = busy; cancel.disabled = !busy; }
    function progress(value) {
        const labels = { census: '枚举聊天与备份', files: '读取剧情文件', references: '检查完整引用', done: '扫描完成' };
        const completed = Number.isFinite(value?.completed) ? value.completed : 0;
        const total = Number.isFinite(value?.total) ? ` / ${value.total}` : '';
        status.textContent = `${labels[value?.phase] || '正在扫描'}：${completed}${total}`;
    }
    async function runScan() {
        if (controller || disposed) return;
        const runtime = getRuntime();
        if (typeof runtime?.scanStoryLibrary !== 'function') {
            status.textContent = '全库扫描尚不可用，请等待插件初始化或重新加载。'; return;
        }
        const token = ++generation;
        controller = new AbortController(); result = null; previewOpen = false;
        pages.chat = pages.backup = pages.candidates = 0; results.textContent = '';
        setBusy(true); status.textContent = '正在准备全库扫描…';
        try {
            const value = await runtime.scanStoryLibrary({ signal: controller.signal, onProgress: value => {
                if (!disposed && token === generation) progress(value);
            } });
            if (disposed || token !== generation) return;
            result = value; render();
            status.textContent = result.complete ? '宿主可枚举范围扫描完成；未发现引用不等于可以安全删除。' : '扫描不完整：不能据此认定任何文件可删除。';
        } catch (error) {
            if (disposed || token !== generation) return;
            status.textContent = `扫描失败，未修改文件：${error?.message || String(error)}`;
            report(status.textContent, 'error');
        } finally {
            if (!disposed && token === generation) { controller = null; setBusy(false); }
        }
    }
    async function exportCandidates() {
        if (controller || disposed || !(result?.observedUnreferenced || result?.candidates)?.length) return;
        const runtime = getRuntime();
        if (typeof runtime?.exportStoryLibraryCandidates !== 'function') {
            status.textContent = '当前版本未提供候选备份导出，请重新加载插件。'; return;
        }
        const token = ++generation;
        controller = new AbortController(); exporting = true; setBusy(true); render();
        status.textContent = '重新核验候选引用并准备备份；不会删除文件…';
        try {
            const bundle = await runtime.exportStoryLibraryCandidates(result, { signal: controller.signal });
            if (disposed || token !== generation) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
            const anchor = make('a'); anchor.href = url;
            anchor.download = `amin-os-unreferenced-candidates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            document.body.append(anchor);
            try { anchor.click(); }
            finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
            status.textContent = '候选文件备份已下载；原文件仍保留，未执行清理。';
        } catch (error) {
            if (disposed || token !== generation) return;
            status.textContent = `候选备份导出失败，未修改文件：${error?.message || String(error)}`;
            report(status.textContent, 'error');
        } finally {
            if (!disposed && token === generation) { controller = null; exporting = false; setBusy(false); render(); }
        }
    }
    function paged(target, rows, key, renderRow) {
        const count = Math.max(1, Math.ceil(rows.length / pageSize));
        pages[key] = Math.min(pages[key], count - 1);
        rows.slice(pages[key] * pageSize, (pages[key] + 1) * pageSize).forEach(row => target.append(renderRow(row)));
        if (rows.length <= pageSize) return;
        const nav = make('div', '', 'amin-toolbar');
        const prev = button('上一页', () => { pages[key]--; render(); }, nav);
        prev.disabled = pages[key] === 0;
        nav.append(make('span', `${pages[key] + 1} / ${count}`, 'amin-meta'));
        const next = button('下一页', () => { pages[key]++; render(); }, nav);
        next.disabled = pages[key] + 1 >= count; target.append(nav);
    }
    function sourceSection(kind, title) {
        const rows = (result.chats || []).filter(row => row.kind === kind);
        const section = make('details', '', 'amin-stack');
        section.open = expanded[kind]; section.ontoggle = () => { expanded[kind] = section.open; };
        section.append(make('summary', `${title}（${rows.length}）`));
        if (!rows.length) section.append(make('p', '本次扫描未发现此类记录。', 'amin-meta'));
        paged(section, rows, kind, row => {
            const card = make('div', '', 'amin-card');
            card.append(make('strong', row.label || row.id),
                make('p', `${row.files || 0} 个关联外置文件 · ${size(row.bytes)} · 独占 ${size(row.exclusiveBytes)} · 共享 ${size(row.sharedBytes)}`, 'amin-meta'),
                make('p', `宿主${kind === 'backup' ? '备份文档（已解压）' : '聊天文档'}：${Number.isFinite(row.documentBytes) ? size(row.documentBytes) : '大小未知'}；与上方外置依赖独立统计。`, 'amin-meta'));
            return card;
        });
        results.append(section);
    }
    function render() {
        results.textContent = ''; if (!result) return;
        const s = result.summary || {};
        results.append(make('p', `已扫描外置文件：${s.files || 0} 个 · ${size(s.bytes)}；已引用 ${s.referencedFiles || 0} 个 · ${size(s.referencedBytes)}；共享 ${s.sharedFiles || 0} 个 · ${size(s.sharedBytes)}。`, 'amin-meta'));
        results.append(make('p', `已读取宿主文档逻辑大小：聊天 ${Number.isFinite(s.chatDocumentBytes) ? size(s.chatDocumentBytes) : '未知'} · 备份（已解压）${Number.isFinite(s.backupDocumentBytes) ? size(s.backupDocumentBytes) : '未知'}。两项与外置文件分开统计；不代表同步传输量。`, 'amin-meta'));
        if (result.duplicatePolicy) results.append(make('p', result.duplicatePolicy, 'amin-meta'));
        results.append(make('p', '独占／共享按本次扫描中的聊天及备份引用来源计算；分支复用的文件不会重复计入全库总量。', 'amin-meta'));
        sourceSection('chat', '聊天与分支'); sourceSection('backup', '备份引用');
        if (result.issues?.length) {
            const issues = make('details', '', 'amin-stack');
            issues.open = expanded.issues; issues.ontoggle = () => { expanded.issues = issues.open; };
            issues.append(make('summary', `扫描问题（${result.issues.length}）`));
            for (const item of result.issues.slice(0, 100)) issues.append(make('p', `${item.id ? `${item.id}：` : ''}${item.message || item.code}`, 'amin-meta'));
            if (result.issues.length > 100) issues.append(make('p', '仅展示前 100 项；请解决扫描问题后重试。', 'amin-meta'));
            results.append(issues);
        }
        const clean = make('section', '', 'amin-stack');
        clean.append(make('h4', '清理预览'));
        {
            const candidates = result.observedUnreferenced || result.candidates || [];
            clean.append(make('p', `当前扫描未发现引用：${candidates.length} 个文件 · ${size(candidates.reduce((sum, item) => sum + (item.bytes || 0), 0))}。不等于可删除；扫描未覆盖的聊天或备份仍可能引用这些文件。`, 'amin-meta'));
            if (candidates.length) {
                button(previewOpen ? '收起候选文件预览' : '预览候选文件', () => { previewOpen = !previewOpen; render(); }, clean);
                if (previewOpen) {
                    paged(clean, candidates, 'candidates', row => {
                        const card = make('div', '', 'amin-card');
                        card.append(make('code', row.id), make('p', size(row.bytes), 'amin-meta')); return card;
                    });
                    const exportButton = button(exporting ? '正在核验并导出…' : '重新核验并导出候选备份', () => void exportCandidates(), clean);
                    exportButton.disabled = exporting;
                }
            }
            if (!result.complete) clean.append(make('p', result.cleanupBlockedReason || '引用扫描不完整，已禁止生成可清理文件清单。', 'amin-meta'));
            clean.append(make('p', '永久删除不可用：宿主未提供覆盖全部引用及同步写入的全局排他保护。这里只提供预览与候选备份导出，文件不会自动删除。', 'amin-meta'));
        }
        results.append(clean);
    }
    return { dispose() { disposed = true; generation++; controller?.abort(); controller = null; result = null; box.remove(); } };
}
