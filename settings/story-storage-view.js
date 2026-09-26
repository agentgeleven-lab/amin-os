import { getState2Runtime } from '../apps/state2/runtime.js';
import { captureContext, assertContext, chatIdentity } from '../apps/shared/operations.js';
import { mountPerformanceDiagnostics } from './performance-view.js';

const context = () => globalThis.SillyTavern?.getContext?.();
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};

function ensureSameChat(metadata, identity) {
  const current = context();
  if (current?.chatMetadata !== metadata || chatIdentity(current) !== identity) {
    throw Error('聊天已切换；请在当前聊天重新操作剧情存储。');
  }
}

function downloadStory(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = make('a');
  anchor.href = url;
  anchor.download = `amin-os-story-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Management only. The runtime owns validation, file writes and chat binding. */
export function mountStoryStorage(target, report, getRuntime = getState2Runtime) {
  let disposed = false, busy = false, revision = 0, importToken = null, inspection = null;
  const box = make('section', null, 'amin-card amin-stack');
  box.append(make('h3', '剧情文件存储', 'amin-section-heading'));
  const mode = make('p', '正在检查当前聊天…', 'amin-meta');
  const detail = make('p', null, 'amin-meta');
  const stats = make('p', null, 'amin-meta');
  const indexView = make('section', null, 'amin-stack');
  let indexInspection = null, indexPage = 0;
  const controls = make('div', null, 'amin-toolbar');
  const button = (label, action) => {
    const node = make('button', label);
    node.type = 'button';
    node.onclick = action;
    controls.append(node);
    return node;
  };
  const enable = button('为当前聊天启用文件存储', () => void run(async runtime => {
    const token = captureContext(context), metadata = token.metadata, identity = token.identity;
    const result = await runtime.enableStoryStorage();
    ensureSameChat(metadata, identity);
    inspection = null;
    report(result?.message || '当前聊天已启用剧情文件存储；旧楼层数据仍保留。');
  }));
  const exportButton = button('导出当前聊天剧情备份', () => void run(async runtime => {
    const token = captureContext(context);
    const bundle = await runtime.exportStory();
    assertContext(context, token);
    downloadStory(bundle);
    report('剧情备份已下载。迁移设备时还需同步对应聊天文件。');
  }));
  const fileInput = make('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  const importButton = button('导入剧情备份文件', () => {
    try {
      importToken = captureContext(context);
      fileInput.value = '';
      fileInput.click();
    } catch (error) { report(error.message, 'error'); }
  });
  fileInput.onchange = () => {
    const file = fileInput.files?.[0], token = importToken;
    importToken = null;
    if (!file || !token) return;
    void run(async runtime => {
      const raw = await file.text();
      assertContext(context, token);
      let bundle;
      try { bundle = JSON.parse(raw); }
      catch { throw Error('备份文件不是有效的 JSON。'); }
      const result = await runtime.importStory(bundle);
      ensureSameChat(token.metadata, token.identity);
      inspection = null;
      report(result?.message || '剧情备份已校验并导入；当前小白变量未自动恢复。');
    });
  };
  const inspect = button('统计当前聊天占用', () => void run(async runtime => {
    const token = captureContext(context);
    const value = await runtime.inspectStoryStorage();
    assertContext(context, token);
    inspection = { metadata: token.metadata, identity: token.identity, value };
    report('当前聊天的剧情存储占用已统计。');
  }));
  const browse = button('检查楼层与 Swipe 存档', () => void run(async runtime => {
    const token = captureContext(context);
    const value = await runtime.inspectStoryIndex();
    assertContext(context, token);
    indexInspection = { metadata: token.metadata, identity: token.identity, value };
    indexPage = 0;
    renderIndex();
    report(`已检查 ${value.rows.length} 条楼层与 Swipe 记录；${value.unreadableStates} 个状态不可读取。`);
  }));
  const refresh = button('刷新状态', () => void loadStatus());
  controls.append(fileInput);
  box.append(
    make('p', 'Amin 新增的历史记录使用短引用，实际剧情快照写入 TauriTavern 扩展文件存储。小白变量 2.0 的当前变量与原生楼层日志仍保存在聊天元数据。新聊天首次迁移变量时会自动启用文件模式；也可用下方按钮手动启用。启用时聊天最多只能有一条消息。', 'amin-meta'),
    mode, detail, stats, controls, indexView,
    make('p', '跨设备同步时，必须同时同步聊天文件和 extensions.store 扩展存储。只同步聊天文件会使历史状态引用无法读取。', 'amin-meta'),
    make('p', '导入会先验证备份并写入文件，不会自动覆盖当前小白变量。旧聊天记录与原有数据不会自动删除。', 'amin-meta'),
  );
  target.append(box);
  const performanceView = mountPerformanceDiagnostics(target);

  const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} B`;

  function renderIndex() {
    indexView.textContent = '';
    const data = indexInspection?.value;
    if (!data) return;
    indexView.append(make('h4', '当前聊天存档索引'));
    indexView.append(make('p', data.inheritedFrom
      ? `分支继承来源：${data.inheritedFrom.chat}。历史文件可与原聊天共享。`
      : '未记录分支来源。', 'amin-meta'));
    indexView.append(make('p', `起始状态：${data.baseHealth.readable ? '可读取' : '不可读取'} · ${data.states} 个不同状态 · ${data.unreadableStates} 个不可读取`, 'amin-meta'));
    if (data.storage) indexView.append(make('p', `关联文件 JSON 大小：索引及依赖 ${size(data.storage.indexBytes)} · 状态及依赖 ${size(data.storage.stateBytes)} · 合计 ${size(data.storage.totalBytes)}。包含其他分支可能共享的文件，不代表当前聊天独占空间或全局占用。`, 'amin-meta'));
    if (data.storageError) indexView.append(make('p', `文件大小统计未完成：${data.storageError}`, 'amin-meta'));
    if (!data.indexed) indexView.append(make('p', '旧引用预览；检查不会执行迁移或写入。', 'amin-meta'));
    const pageSize = 50, start = indexPage * pageSize;
    for (const row of data.rows.slice(start, start + pageSize)) {
      const label = row.stateId ? row.readable ? '可读取' : '不可读取'
        : row.role === 'assistant' ? '尚无存档' : '沿用之前状态';
      const item = make('details', null, 'amin-card');
      item.append(make('summary', `第 ${row.floor + 1} 楼 · Swipe ${row.swipe + 1}${row.selected ? '（当前）' : ''} · ${label}`));
      const state = make('p', row.stateId ? `状态文件：${row.stateId}` : '此候选没有独立状态文件。', 'amin-meta');
      state.style && (state.style.overflowWrap = 'anywhere');
      item.append(state);
      if (row.error) item.append(make('p', row.error, 'amin-meta'));
      indexView.append(item);
    }
    if (data.rows.length > pageSize) {
      const nav = make('div', null, 'amin-toolbar');
      for (const [label, delta] of [['上一页', -1], ['下一页', 1]]) {
        const button = make('button', label); button.type = 'button';
        button.disabled = delta < 0 ? indexPage === 0 : start + pageSize >= data.rows.length;
        button.onclick = () => { indexPage += delta; renderIndex(); }; nav.append(button);
      }
      nav.append(make('span', `${indexPage + 1} / ${Math.ceil(data.rows.length / pageSize)}`, 'amin-meta'));
      indexView.append(nav);
    }
    indexView.append(make('p', data.cleanupReason, 'amin-meta'));
  }

  function showStats(value) {
    const parts = [];
    if (Number.isFinite(value?.bytes)) parts.push(`文件内容约 ${size(value.bytes)}`);
    if (Number.isFinite(value?.records)) parts.push(`${value.records} 条记录`);
    if (Number.isFinite(value?.checkpointCount)) parts.push(`${value.checkpointCount} 个检查点`);
    if (Number.isFinite(value?.deltaCount)) parts.push(`${value.deltaCount} 条差量`);
    if (Number.isFinite(value?.referenceBytes)) parts.push(`消息引用 ${size(value.referenceBytes)}`);
    stats.textContent = parts.length ? `当前聊天估算占用：${parts.join(' · ')}` : '占用统计没有返回可显示的数据。';
  }

  async function loadStatus() {
    const ticket = ++revision;
    const source = context(), metadata = source?.chatMetadata, identity = chatIdentity(source);
    try {
      const runtime = getRuntime();
      const status = await runtime?.storyStatus?.();
      if (disposed || ticket !== revision) return;
      if (context()?.chatMetadata !== metadata || chatIdentity(context()) !== identity) {
        inspection = null;
        indexInspection = null; renderIndex();
        mode.textContent = '聊天已切换，请刷新当前聊天的剧情存储状态。';
        detail.textContent = '';
        stats.textContent = '';
        enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = true;
        refresh.disabled = false;
        return;
      }
      const available = !!status?.available;
      if (indexInspection && (indexInspection.metadata !== metadata || indexInspection.identity !== identity)) {
        indexInspection = null; renderIndex();
      }
      mode.textContent = status?.enabled ? '当前聊天：剧情文件存储已启用。' : '当前聊天：尚未启用剧情文件存储。';
      detail.textContent = status?.message || (runtime ? '当前聊天的剧情存储状态尚不可用。' : '剧情存储尚未初始化，请刷新酒馆。');
      if (inspection?.metadata === metadata && inspection.identity === identity) showStats(inspection.value);
      else if (Number.isFinite(status?.bytes ?? status?.sizeBytes)) showStats({bytes:status.bytes ?? status.sizeBytes,records:status.records ?? status.recordCount});
      else stats.textContent = '点击「统计当前聊天占用」按需扫描剧情文件。';
      enable.disabled = busy || !available || !!status?.enabled;
      exportButton.disabled = busy || !available || !status?.enabled;
      importButton.disabled = busy || !available;
      inspect.disabled = busy || !available || !status?.enabled;
      browse.disabled = busy || !available || !status?.enabled || typeof runtime?.inspectStoryIndex !== 'function';
      refresh.disabled = busy;
    } catch (error) {
      if (disposed || ticket !== revision) return;
      mode.textContent = '剧情文件存储状态读取失败。';
      detail.textContent = error.message;
      stats.textContent = '';
      enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = true;
      refresh.disabled = false;
      report(error.message, 'error');
    }
  }

  async function run(work) {
    if (busy || disposed) return;
    const runtime = getRuntime();
    if (!runtime) { report('剧情存储尚未初始化，请刷新酒馆。', 'error'); return; }
    busy = true;
    enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = refresh.disabled = true;
    try { await work(runtime); }
    catch (error) { report(error.message, 'error'); }
    finally { busy = false; if (!disposed) await loadStatus(); }
  }

  void loadStatus();
  return { dispose() { disposed = true; revision++; importToken = null; performanceView.dispose(); } };
}
