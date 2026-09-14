export function enablePanelDrag(panel, handle, { context, settingsKey }) {
  let drag = null;
  function place(x, y) {
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    panel.style.left = Math.max(0, Math.min(maxX, x)) + 'px';
    panel.style.top = Math.max(0, Math.min(maxY, y)) + 'px';
  }
  function save() {
    const c = context(), rect = panel.getBoundingClientRect();
    c.extensionSettings[settingsKey] = { ...c.extensionSettings[settingsKey], panelPosition: { x: rect.left, y: rect.top } };
    c.saveSettingsDebounced();
  }
  const saved = context().extensionSettings[settingsKey]?.panelPosition;
  const rect = panel.getBoundingClientRect();
  place(Number.isFinite(saved?.x) ? saved.x : rect.left, Number.isFinite(saved?.y) ? saved.y : rect.top);
  const resize = () => { const r = panel.getBoundingClientRect(); place(r.left, r.top); };
  window.addEventListener('resize', resize);
  handle.tabIndex = 0;
  handle.title = '拖动标题栏移动窗口；聚焦后可用方向键移动';
  handle.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture(e.pointerId);
    panel.classList.add('wsh-dragging'); e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    place(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
    e.preventDefault();
  });
  function finish(e) {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null; panel.classList.remove('wsh-dragging'); save();
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', e => {
    if (e.target !== handle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); const r = panel.getBoundingClientRect();
    place(r.left + (e.key === 'ArrowLeft' ? -12 : e.key === 'ArrowRight' ? 12 : 0),
      r.top + (e.key === 'ArrowUp' ? -12 : e.key === 'ArrowDown' ? 12 : 0)); save();
  });
  panel.addEventListener('close', () => { drag = null; window.removeEventListener('resize', resize); }, { once: true });
}
