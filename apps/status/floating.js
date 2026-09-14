// A single launcher follows the viewport; state remains in each chat's metadata.
export function installFloatingButton({ context, settingsKey, identity, toggle, changed, error }) {
  if (document.getElementById('wsh-launcher')) return;
  const button = document.createElement('button');
  button.id = 'wsh-launcher'; button.type = 'button'; button.textContent = '状态';
  button.title = '点击打开状态栏，拖动调整位置';
  button.setAttribute('aria-label', '打开或关闭当前角色状态栏；可拖动');
  document.body.append(button);
  let drag = null, suppressClick = false;
  const margin = 8, size = 48;
  function position(x, y) {
    const maxX = Math.max(margin, window.innerWidth - size - margin);
    const maxY = Math.max(margin, window.innerHeight - size - margin);
    button.style.left = Math.max(margin, Math.min(maxX, x)) + 'px';
    button.style.top = Math.max(margin, Math.min(maxY, y)) + 'px';
  }
  function restorePosition() {
    const p = context().extensionSettings[settingsKey]?.launcherPosition;
    position(Number.isFinite(p?.x) ? p.x : window.innerWidth - 70,
      Number.isFinite(p?.y) ? p.y : window.innerHeight * 0.65);
  }
  function savePosition() {
    const c = context();
    c.extensionSettings[settingsKey] = { ...c.extensionSettings[settingsKey], launcherPosition: {
      x: parseFloat(button.style.left), y: parseFloat(button.style.top),
    } };
    c.saveSettingsDebounced();
  }
  button.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    suppressClick = false;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY,
      left: parseFloat(button.style.left), top: parseFloat(button.style.top), moved: false };
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) { position(drag.left + dx, drag.top + dy); e.preventDefault(); }
  });
  function finish(e) {
    if (!drag || drag.id !== e.pointerId) return;
    suppressClick = drag.moved || e.type === 'pointercancel';
    if (drag.moved) savePosition();
    drag = null;
    if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
  }
  button.addEventListener('pointerup', finish);
  button.addEventListener('pointercancel', finish);
  button.addEventListener('lostpointercapture', () => { if (drag) { suppressClick = true; drag = null; } });
  button.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    Promise.resolve().then(toggle).catch(error);
  });
  button.addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const dx = e.key === 'ArrowLeft' ? -12 : e.key === 'ArrowRight' ? 12 : 0;
    const dy = e.key === 'ArrowUp' ? -12 : e.key === 'ArrowDown' ? 12 : 0;
    position(parseFloat(button.style.left) + dx, parseFloat(button.style.top) + dy); savePosition();
  });
  window.addEventListener('resize', () => position(parseFloat(button.style.left), parseFloat(button.style.top)));
  restorePosition();
  let previous;
  function watch() {
    let next;
    try { next = identity(); } catch { next = null; }
    const name = next ? context().characters[context().characterId]?.name : null;
    button.title = name ? name + ' · 点击查看状态栏，拖动调整位置' : '请先打开单角色聊天';
    if (previous === undefined) { previous = next; return; }
    if (previous?.metadata === next?.metadata && previous?.id === next?.id && previous?.avatar === next?.avatar) return;
    previous = next;
    Promise.resolve().then(changed).catch(error);
  }
  watch();
  const c = context(), event = c.eventTypes?.CHAT_CHANGED || c.event_types?.CHAT_CHANGED;
  if (event && c.eventSource?.on) c.eventSource.on(event, watch);
  // Covers hosts whose chat-change event occurs before metadata is replaced.
  setInterval(watch, 500);
}
