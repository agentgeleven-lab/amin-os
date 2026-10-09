import { getState2Runtime } from '../apps/state2/runtime.js';
import { captureContext, chatIdentity, chatPath, metadataWriteStatus } from '../apps/shared/operations.js';
import { assertChatReady } from '../apps/shared/chat-lifecycle.js';
import { mountPerformanceDiagnostics } from './performance-view.js';
import { mountStoryLibrary } from './story-library-view.js';

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

// File recovery must remain available when native variables cannot restore.
// These view-only snapshots never authorize a metadata write or run the normal
// operation preparation, but still reject host loading and changed candidates.
function managementContext() {
  const ctx = context();
  assertChatReady(ctx);
  const id = ctx?.getCurrentChatId?.() ?? ctx?.chatId;
  if (!ctx?.chatMetadata || typeof ctx.chatMetadata !== 'object' || Array.isArray(ctx.chatMetadata)
      || !Array.isArray(ctx.chat) || id == null || id === '') throw Error('请先打开一个聊天。');
  return ctx;
}
function captureManagementContext() {
  const ctx = managementContext();
  return { metadata: ctx.chatMetadata, integrity: ctx.chatMetadata.integrity, identity: chatIdentity(ctx),
    path: JSON.stringify(chatPath(ctx.chat)),
    swipes: ctx.chat.map(message => Array.isArray(message.swipes) ? message.swipes.slice() : null) };
}
function assertManagementContext(token) {
  const ctx = managementContext();
  if (ctx.chatMetadata !== token.metadata || ctx.chatMetadata.integrity !== token.integrity
      || chatIdentity(ctx) !== token.identity || JSON.stringify(chatPath(ctx.chat)) !== token.path
      || ctx.chat.some((message, index) => {
        const before = token.swipes[index], now = Array.isArray(message.swipes) ? message.swipes : null;
        return (before === null) !== (now === null)
          || now && (now.length !== before.length || now.some((text, swipe) => text !== before[swipe]));
      })) throw Error('聊天或消息候选已变化，请在当前聊天重新操作剧情存储。');
  return ctx;
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
  let sourceToken = null, identityPreview = null;
  let resetPreview = null, backupPreview = null;
  const box = make('section', null, 'amin-card amin-stack');
  box.append(make('h3', '剧情文件存储', 'amin-section-heading'));
  const mode = make('p', '正在检查当前聊天…', 'amin-meta');
  const detail = make('p', null, 'amin-meta');
  const recovery = make('p', null, 'amin-notice');
  recovery.hidden = true;
  const stats = make('p', null, 'amin-meta');
  const indexView = make('section', null, 'amin-stack');
  const identityView = make('section', null, 'amin-stack');
  identityView.hidden = true;
  let indexInspection = null, indexPage = 0;
  const controls = make('div', null, 'amin-toolbar');
  const recoveryControls = make('div', null, 'amin-toolbar');
  const legacyNotes = make('div', null, 'amin-stack');
  const simpleControls = make('div', null, 'amin-toolbar');
  const resetView = make('section', null, 'amin-card amin-stack'); resetView.hidden = true;
  const backupsView = make('section', null, 'amin-stack'); backupsView.hidden = true;
  const button = (label, action, target = controls) => {
    const node = make('button', label);
    node.type = 'button';
    node.onclick = action;
    target.append(node);
    return node;
  };
  const nativeBasis = ctx => JSON.stringify([ctx.chatMetadata.variables ?? {}, ctx.chatMetadata.LWB_RULES_V2 ?? {}]);
  const simpleSwitch = button('改用简洁存储（保留当前变量）', () => void run(async runtime => {
    const token = captureManagementContext();
    const result = await runtime.switchToCurrentStory({ clear: false });
    assertManagementContext(token);
    clearResetPreview(); clearBackupPreview(); clearIdentityPreview();
    inspection = null; indexInspection = null; renderIndex();
    report(result?.message || '已改用简洁存储：保留当前变量和最近 5 份备份，切换楼层和 Swipe 不再回退变量。');
  }), simpleControls);
  const resetCurrent = button('备份并清空当前变量', () => {
    try {
      const token = captureManagementContext(), ctx = assertManagementContext(token);
      resetPreview = { token, basis: nativeBasis(ctx) };
      resetView.hidden = false;
      report('请核对清空范围，再点击「确认备份并清空」。');
    } catch (error) { clearResetPreview(); report(error.message, 'error'); }
  }, simpleControls);
  resetView.append(make('p', '将先备份当前变量，再清空本聊天的人物、背包、关系、场景、剧情、持续效果、地图、信息、骰子、世界状态和势力资料。清空后可重新生成。聊天正文、全局能力库、世界书和 API 设置保留。清空会启用简洁存储，旧楼层和 Swipe 不再自动回退变量。', 'amin-meta'));
  const confirmReset = button('确认备份并清空', () => void run(async runtime => {
    if (!resetPreview) throw Error('请先核对清空范围。');
    const preview = resetPreview, ctx = assertManagementContext(preview.token);
    if (nativeBasis(ctx) !== preview.basis) throw Error('变量或规则已变化，请重新核对清空范围。');
    clearResetPreview();
    const result = await runtime.resetCurrentStory();
    assertManagementContext(preview.token);
    clearBackupPreview(); clearIdentityPreview();
    inspection = null; indexInspection = null; renderIndex();
    report(result?.message || '已备份并清空当前变量；可以重新生成资料。');
  }), resetView);
  const cancelReset = button('取消清空', () => clearResetPreview(), resetView);
  const inspectBackups = button('查看最近备份', () => void run(async runtime => {
    const token = captureManagementContext();
    const basis = nativeBasis(assertManagementContext(token));
    const value = await runtime.inspectCurrentStoryBackups();
    if (nativeBasis(assertManagementContext(token)) !== basis) throw Error('变量或规则已变化，请重新查看备份。');
    backupPreview = { token, value, basis };
    renderBackups();
    report(value.backups.length ? `已读取最近 ${value.backups.length} 份变量备份。` : '当前还没有变量备份。');
  }), simpleControls);
  const backupSelect = make('select'); backupSelect.setAttribute?.('aria-label', '选择变量备份');
  const restoreBackup = button('恢复所选备份', () => void run(async runtime => {
    if (!backupPreview) throw Error('请先查看最近备份。');
    const preview = backupPreview;
    const ctx = assertManagementContext(preview.token);
    if (nativeBasis(ctx) !== preview.basis) throw Error('变量或规则已变化，请重新查看备份再恢复。');
    const entry = preview.value.backups.find(item => item.index === Number(backupSelect.value));
    if (!entry) throw Error('请选择一份变量备份。');
    clearBackupPreview();
    const result = await runtime.restoreCurrentStoryBackup(entry.index, { expectedHash: entry.hash });
    assertManagementContext(preview.token);
    clearResetPreview(); inspection = null;
    report(result?.message || '已恢复所选变量备份，聊天正文保留。');
  }), backupsView);
  const enable = button('为当前聊天启用文件存储', () => void run(async runtime => {
    const token = captureContext(context), metadata = token.metadata, identity = token.identity;
    const result = await runtime.enableStoryStorage();
    ensureSameChat(metadata, identity);
    inspection = null;
    report(result?.message || '当前聊天已启用剧情文件存储；旧楼层数据仍保留。');
  }));
  const exportButton = button('导出当前聊天剧情备份', () => void run(async runtime => {
    const token = captureManagementContext();
    const bundle = await runtime.exportStory();
    assertManagementContext(token);
    downloadStory(bundle);
    report('剧情备份已下载。迁移设备时还需同步对应聊天文件。');
  }));
  const fileInput = make('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  const importButton = button('导入剧情备份文件', () => {
    try {
      importToken = captureManagementContext();
      fileInput.value = '';
      fileInput.click();
    } catch (error) { importToken = null; report(error.message, 'error'); }
  }, recoveryControls);
  fileInput.onchange = () => {
    const file = fileInput.files?.[0], token = importToken;
    importToken = null;
    if (!file || !token) return;
    void run(async runtime => {
      const raw = await file.text();
      assertManagementContext(token);
      let bundle;
      try { bundle = JSON.parse(raw); }
      catch { throw Error('备份文件不是有效的 JSON。'); }
      const result = await runtime.importStory(bundle);
      assertManagementContext(token);
      inspection = null;
      clearIdentityPreview();
      const simple = !!context()?.chatMetadata?.amin_os_current_story_v1;
      report(result?.message || (simple
        ? '变量备份已校验并导入；请点击「重新载入当前变量」。'
        : '剧情备份已校验并导入；请点击「重试恢复当前分支」恢复楼层变量。'));
    });
  };
  const sourceInput = make('input');
  sourceInput.type = 'file';
  sourceInput.accept = '.jsonl,application/x-ndjson';
  sourceInput.hidden = true;
  const verifyIdentities = button('用原聊天校验 Swipe 标识', () => {
    try {
      sourceToken = captureManagementContext();
      clearIdentityPreview();
      sourceInput.value = '';
      sourceInput.click();
    } catch (error) { sourceToken = null; report(error.message, 'error'); }
  }, recoveryControls);
  sourceInput.onchange = () => {
    const file = sourceInput.files?.[0], token = sourceToken;
    sourceToken = null;
    if (!file || !token) return;
    void run(async runtime => {
      const raw = await file.text();
      if (disposed) return;
      assertManagementContext(token);
      const value = await runtime.inspectStoryIdentityRecovery(raw);
      if (disposed) return;
      assertManagementContext(token);
      identityPreview = { token, value };
      renderIdentityPreview();
      report(value.rows.length || value.mirrors.length
        ? '已用原聊天校验候选。请检查下方修复预览，再点击「应用标识修复」。'
        : '候选标识与原聊天一致，无需修复。');
    });
  };
  const applyIdentities = button('应用标识修复', () => void run(async runtime => {
    const preview = identityPreview;
    if (!preview) throw Error('请先用原聊天校验 Swipe 标识。');
    assertManagementContext(preview.token);
    // The service owns an opaque, one-use proof. Clear the preview even when a
    // save fails; the current candidates must be checked again before retrying.
    clearIdentityPreview();
    const result = await runtime.repairStoryIdentities(preview.value.plan);
    if (disposed) return;
    assertManagementContext(preview.token);
    inspection = null;
    indexInspection = null; renderIndex();
    report(result?.message || '候选标识已修复；正文与变量未改写，请点击「重试恢复当前分支」。');
  }), identityView);
  applyIdentities.disabled = true;
  const inspect = button('统计当前聊天占用', () => void run(async runtime => {
    const token = captureManagementContext();
    const value = await runtime.inspectStoryStorage();
    assertManagementContext(token);
    inspection = { metadata: token.metadata, identity: token.identity, value };
    report('当前聊天的剧情存储占用已统计。');
  }));
  const browse = button('检查楼层与 Swipe 存档', () => void run(async runtime => {
    const token = captureManagementContext();
    const value = await runtime.inspectStoryIndex();
    assertManagementContext(token);
    indexInspection = { metadata: token.metadata, identity: token.identity, value };
    indexPage = 0;
    renderIndex();
    report(`已检查 ${value.rows.length} 条楼层与 Swipe 记录；${value.unreadableStates} 个状态不可读取。`);
  }));
  const retry = button('重试恢复当前分支', () => void run(async runtime => {
    const token = captureManagementContext(), status = runtime.status?.();
    const ctx = assertManagementContext(token), lock = metadataWriteStatus(context);
    if (status?.generating || ctx.streamingProcessor && !ctx.streamingProcessor.isFinished)
      throw Error('请等待生成结束后再恢复当前分支。');
    if (status?.restoring || lock.busy) throw Error('当前聊天正在恢复或保存，请稍后重试。');
    if (lock.dirty) throw Error('当前聊天有尚未保存的操作，请先重试保存。');
    await runtime.restoreChat();
    assertManagementContext(token);
    const restored = runtime.status?.();
    if (!runtime.ready?.()) throw Error(restored?.restoreError || restored?.message || '当前聊天的楼层变量尚未恢复完成，请重试。');
    inspection = null;
    clearIdentityPreview();
    indexInspection = null; renderIndex();
    report(restored?.message || '已恢复当前分支楼层变量。');
  }), recoveryControls);
  const refresh = button('刷新状态', () => void loadStatus());
  const simpleImport = button('导入变量备份', () => importButton.onclick(), simpleControls);
  const simpleReload = button('重新载入当前变量', () => retry.onclick(), simpleControls);
  controls.append(fileInput, sourceInput);
  clearIdentityPreview();
  legacyNotes.append(
    make('p', '以下说明仅适用于旧式楼层存档。若提示 Swipe 标识重复或缺失：先导入剧情备份，再用原聊天 JSONL 校验并预览修复，完成后重试恢复当前分支。', 'amin-meta'),
    make('p', '旧模式将历史快照写入扩展文件存储，聊天保存索引和小白变量楼层日志。手动启用旧模式时聊天最多只能有一条消息；已有长聊天可直接使用上方简洁存储入口。', 'amin-meta'),
  );
  box.append(
    mode, detail,
    make('p', '简洁存储：每个聊天用一个外置文件保存当前变量及最近 5 份备份，无需校验 Swipe 或匹配旧楼层。备份数量固定；变量内容自身变多时文件也会变大。', 'amin-meta'),
    simpleControls, resetView, backupsView, recovery, recoveryControls, identityView,
    legacyNotes,
    stats, controls, indexView,
    make('p', '迁移设备需同步聊天及 extensions.store 扩展存储，或在目标设备导入对应聊天的变量备份。导入只写入备份文件，再手动重新载入变量。旧存档不会自动删除。', 'amin-meta'),
  );
  target.append(box);
  const advanced = make('details', null, 'amin-card amin-stack');
  advanced.append(make('summary', '旧历史存档与诊断工具'));
  target.append(advanced);
  const libraryView = mountStoryLibrary(advanced, { getRuntime, report });
  const performanceView = mountPerformanceDiagnostics(advanced);

  const size = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} B`;

  function clearIdentityPreview() {
    identityPreview = null;
    identityView.textContent = '';
    identityView.hidden = true;
    identityView.append(applyIdentities);
    applyIdentities.disabled = true;
  }
  function clearResetPreview() { resetPreview = null; resetView.hidden = true; }
  function clearBackupPreview() {
    backupPreview = null; backupsView.textContent = ''; backupsView.hidden = true;
    restoreBackup.disabled = true; backupsView.append(restoreBackup);
  }
  function renderBackups() {
    backupsView.textContent = ''; backupsView.hidden = false;
    backupsView.append(make('h4', '最近 5 份变量备份'));
    backupSelect.textContent = '';
    const entries = backupPreview.value.backups;
    for (const entry of entries) {
      const date = typeof entry.at === 'number' ? new Date(entry.at).toLocaleString() : entry.at;
      const option = make('option', `${date || '时间未知'} · ${entry.label || '变量备份'}`);
      option.value = String(entry.index); backupSelect.append(option);
    }
    backupSelect.value = entries.length ? String(entries[0].index) : '';
    if (!entries.length) backupsView.append(make('p', '当前还没有变量备份。', 'amin-meta'));
    backupsView.append(backupSelect, restoreBackup);
  }
  function renderIdentityPreview() {
    identityView.textContent = '';
    const data = identityPreview?.value;
    if (!data) return;
    identityView.hidden = false;
    identityView.append(make('h4', 'Swipe 标识修复预览'));
    identityView.append(make('p', `需修复 ${data.rows.length} 个候选标识、${data.mirrors.length} 个当前候选镜像。正文、变量与存档文件不会在此步骤改写。`, 'amin-meta'));
    for (const row of data.rows) {
      const item = make('details', null, 'amin-card');
      item.append(make('summary', `第 ${row.floor + 1} 楼 · Swipe ${row.swipe + 1}`));
      for (const text of [`原标识：${row.oldId || '缺失'}`, `恢复标识：${row.newId}`, `原状态文件：${row.stateId || '沿用之前状态'}`]) {
        const line = make('p', text, 'amin-meta');
        line.style && (line.style.overflowWrap = 'anywhere'); item.append(line);
      }
      identityView.append(item);
    }
    for (const mirror of data.mirrors) identityView.append(make('p', `第 ${mirror.floor + 1} 楼：同步当前候选镜像标识。`, 'amin-meta'));
    identityView.append(applyIdentities);
  }

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
        clearResetPreview(); clearBackupPreview();
        clearIdentityPreview();
        indexInspection = null; renderIndex();
        mode.textContent = '聊天已切换，请刷新当前聊天的剧情存储状态。';
        detail.textContent = '';
        recovery.textContent = ''; recovery.hidden = true;
        stats.textContent = '';
        enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = retry.disabled = verifyIdentities.disabled = applyIdentities.disabled = true;
        simpleSwitch.disabled = resetCurrent.disabled = confirmReset.disabled = inspectBackups.disabled = restoreBackup.disabled = true;
        simpleImport.disabled = simpleReload.disabled = true;
        refresh.disabled = false;
        return;
      }
      const available = !!status?.available;
      const simple = status?.currentOnly || status?.mode === 'current-only';
      for (const preview of [resetPreview, backupPreview]) {
        if (!preview) continue;
        try { assertManagementContext(preview.token); }
        catch { clearResetPreview(); clearBackupPreview(); break; }
      }
      recoveryControls.hidden = !!simple;
      legacyNotes.hidden = enable.hidden = browse.hidden = !!simple;
      simpleSwitch.hidden = !!simple && !!status?.enabled;
      simpleImport.hidden = simpleReload.hidden = !simple;
      if (simple) { clearIdentityPreview(); indexInspection = null; renderIndex(); }
      if (identityPreview) {
        try { assertManagementContext(identityPreview.token); }
        catch { clearIdentityPreview(); }
      }
      if (indexInspection && (indexInspection.metadata !== metadata || indexInspection.identity !== identity)) {
        indexInspection = null; renderIndex();
      }
      mode.textContent = simple && status?.enabled ? `当前聊天：简洁存储已启用 · 最近备份 ${status.backupCount ?? 0} / 5。`
        : status?.enabled ? '当前聊天：剧情文件存储已启用。' : '当前聊天：尚未启用剧情文件存储。';
      detail.textContent = status?.message || (runtime ? '当前聊天的剧情存储状态尚不可用。' : '剧情存储尚未初始化，请刷新酒馆。');
      const native = runtime?.status?.();
      recovery.textContent = native?.restoreError ? simple ? `当前变量加载未完成：${native.restoreError}。可导入简洁存储备份，或备份并清空当前变量。`
        : `楼层变量恢复未完成：${native.restoreError}。可以改用简洁存储并保留当前变量，或备份后清空；旧存档修复入口仍可使用。`
        : native?.restoring ? '正在恢复当前分支楼层变量，请稍候。' : '';
      recovery.hidden = !recovery.textContent;
      if (inspection?.metadata === metadata && inspection.identity === identity) showStats(inspection.value);
      else if (Number.isFinite(status?.bytes ?? status?.sizeBytes)) showStats({bytes:status.bytes ?? status.sizeBytes,records:status.records ?? status.recordCount});
      else stats.textContent = '点击「统计当前聊天占用」按需扫描剧情文件。';
      enable.disabled = busy || !available || !!status?.enabled;
      const nativeBusy = !!native?.restoring || !!native?.generating;
      simpleSwitch.disabled = busy || !available || !!simple && !!status?.enabled || nativeBusy || typeof runtime?.switchToCurrentStory !== 'function';
      resetCurrent.disabled = busy || !available || nativeBusy || typeof runtime?.resetCurrentStory !== 'function';
      confirmReset.disabled = resetCurrent.disabled || !resetPreview;
      cancelReset.disabled = busy;
      inspectBackups.disabled = busy || !available || !simple || !status?.enabled || typeof runtime?.inspectCurrentStoryBackups !== 'function';
      restoreBackup.disabled = busy || !available || !simple || nativeBusy || !backupPreview?.value.backups.length || typeof runtime?.restoreCurrentStoryBackup !== 'function';
      simpleImport.disabled = busy || !available || !simple || nativeBusy;
      simpleReload.disabled = busy || !available || !simple || nativeBusy || typeof runtime?.restoreChat !== 'function';
      exportButton.disabled = busy || !available || !status?.enabled;
      importButton.disabled = busy || !available;
      verifyIdentities.disabled = busy || !available || !!simple || !status?.enabled || typeof runtime?.inspectStoryIdentityRecovery !== 'function';
      applyIdentities.disabled = busy || !available || !status?.enabled || typeof runtime?.repairStoryIdentities !== 'function'
        || !identityPreview || !(identityPreview.value.rows.length || identityPreview.value.mirrors.length)
        || !!native?.restoring || !!native?.generating;
      inspect.disabled = busy || !available || !status?.enabled;
      browse.disabled = busy || !available || !!simple || !status?.enabled || typeof runtime?.inspectStoryIndex !== 'function';
      retry.disabled = busy || !available || !status?.enabled || typeof runtime?.restoreChat !== 'function'
        || !!native?.restoring || !!native?.generating;
      refresh.disabled = busy;
    } catch (error) {
      if (disposed || ticket !== revision) return;
      mode.textContent = '剧情文件存储状态读取失败。';
      detail.textContent = error.message;
      stats.textContent = '';
      recovery.textContent = ''; recovery.hidden = true;
      enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = retry.disabled = verifyIdentities.disabled = applyIdentities.disabled = true;
      simpleSwitch.disabled = resetCurrent.disabled = confirmReset.disabled = inspectBackups.disabled = restoreBackup.disabled = true;
      simpleImport.disabled = simpleReload.disabled = true;
      refresh.disabled = false;
      report(error.message, 'error');
    }
  }

  async function run(work) {
    if (busy || disposed) return;
    const runtime = getRuntime();
    if (!runtime) { report('剧情存储尚未初始化，请刷新酒馆。', 'error'); return; }
    busy = true;
    enable.disabled = exportButton.disabled = importButton.disabled = inspect.disabled = browse.disabled = retry.disabled = refresh.disabled = verifyIdentities.disabled = applyIdentities.disabled = true;
    simpleSwitch.disabled = resetCurrent.disabled = confirmReset.disabled = cancelReset.disabled = inspectBackups.disabled = restoreBackup.disabled = true;
    simpleImport.disabled = simpleReload.disabled = true;
    try { await work(runtime); }
    catch (error) { report(error.message, 'error'); }
    finally { busy = false; if (!disposed) await loadStatus(); }
  }

  void loadStatus();
  return { dispose() { disposed = true; revision++; importToken = sourceToken = null; clearIdentityPreview(); clearResetPreview(); clearBackupPreview(); libraryView.dispose(); performanceView.dispose(); } };
}
