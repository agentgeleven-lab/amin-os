import { getState2Runtime } from '../apps/state2/runtime.js';
import { captureContext, assertContext, chatIdentity } from '../apps/shared/operations.js';

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
  const refresh = button('刷新状态', () => void loadStatus());
  controls.append(fileInput);
  box.append(
    make('p', 'Amin 新增的历史记录使用短引用，实际剧情快照写入 TauriTavern 扩展文件存储。小白变量 2.0 的当前变量与原生楼层日志仍保存在聊天元数据。新聊天首次迁移变量时会自动启用文件模式；也可用下方按钮手动启用。启用时聊天最多只能有一条消息。', 'amin-meta'),
    mode, detail, stats, controls,
    make('p', '跨设备同步时，必须同时同步聊天文件和 extensions.store 扩展存储。只同步聊天文件会使历史状态引用无法读取。', 'amin-meta'),
    make('p', '导入会先验证备份并写入文件，不会自动覆盖当前小白变量。旧聊天记录与原有数据不会自动删除。', 'amin-meta'),
  );
  target.append(box);

  const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} B`;

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
        mode.textContent = '聊天已切换，请刷新当前聊天的剧情存储状态。';
        detail.textContent = '';
        stats.textContent = '';
        enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = true;
        refresh.disabled = false;
        return;
      }
      const available = !!status?.available;
      mode.textContent = status?.enabled ? '当前聊天：剧情文件存储已启用。' : '当前聊天：尚未启用剧情文件存储。';
      detail.textContent = status?.message || (runtime ? '当前聊天的剧情存储状态尚不可用。' : '剧情存储尚未初始化，请刷新酒馆。');
      if (inspection?.metadata === metadata && inspection.identity === identity) showStats(inspection.value);
      else if (Number.isFinite(status?.bytes ?? status?.sizeBytes)) showStats({bytes:status.bytes ?? status.sizeBytes,records:status.records ?? status.recordCount});
      else stats.textContent = '点击「统计当前聊天占用」按需扫描剧情文件。';
      enable.disabled = busy || !available || !!status?.enabled;
      exportButton.disabled = busy || !available || !status?.enabled;
      importButton.disabled = busy || !available;
      inspect.disabled = busy || !available || !status?.enabled;
      refresh.disabled = busy;
    } catch (error) {
      if (disposed || ticket !== revision) return;
      mode.textContent = '剧情文件存储状态读取失败。';
      detail.textContent = error.message;
      stats.textContent = '';
      enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = true;
      refresh.disabled = false;
      report(error.message, 'error');
    }
  }

  async function run(work) {
    if (busy || disposed) return;
    const runtime = getRuntime();
    if (!runtime) { report('剧情存储尚未初始化，请刷新酒馆。', 'error'); return; }
    busy = true;
    enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = refresh.disabled = true;
    try { await work(runtime); }
    catch (error) { report(error.message, 'error'); }
    finally { busy = false; if (!disposed) await loadStatus(); }
  }

  void loadStatus();
  return { dispose() { disposed = true; revision++; importToken = null; } };
}
