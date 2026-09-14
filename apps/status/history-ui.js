export function historyView({ history, node, floor = null }) {
  const root = node('section', undefined, 'wsh-history');
  const nav = node('div', undefined, 'wsh-history-nav');
  const left = node('button', '‹'), right = node('button', '›'), latest = node('button', '最新记录');
  left.title = '上一楼'; right.title = '下一楼';
  const label = node('span'); const body = node('div');
  for (const button of [left, right, latest]) button.type = 'button';
  nav.append(left, label, right, latest);
  root.append(nav, node('p', '只读记录 · 翻页不会恢复变量，复制和模型更新仍使用当前剧情状态。', 'wsh-note'), body);
  function render() {
    const rows = history.list();
    const index = floor === null ? rows.length - 1 : Math.min(floor, rows.length - 1);
    const row = rows[index];
    label.textContent = row ? `第 ${index + 1} 楼 · ${row.name}` : '暂无楼层记录';
    left.disabled = index <= 0; right.disabled = index >= rows.length - 1;
    body.replaceChildren();
    if (!row?.available) { body.append(node('p', '此楼层尚无记录。安装前的历史状态无法自动还原。')); return; }
    if (!row.state) { body.append(node('p', '此楼层还没有状态栏。')); return; }
    for (const [name, fields] of Object.entries(row.state.项目 || {})) {
      const card = node('section', undefined, 'wsh-history-card'); card.append(node('strong', name));
      for (const [field, value] of Object.entries(fields)) {
        const line = node('div', undefined, 'wsh-history-field');
        let text = typeof value === 'boolean' ? (value ? '是' : '否') : Array.isArray(value) ? value.join('、') : value && typeof value === 'object' ? `${value.当前} / ${value.最大}` : String(value ?? '');
        if (text.length > 20 || text.includes('\n')) line.classList.add('wsh-history-long');
        line.append(node('span', field), node('span', text)); card.append(line);
      }
      body.append(card);
    }
  }
  left.onclick = () => { floor = Math.max(0, (floor ?? history.list().length - 1) - 1); render(); };
  right.onclick = () => { floor = Math.min(history.list().length - 1, (floor ?? history.list().length - 1) + 1); render(); };
  latest.onclick = () => { floor = null; render(); };
  render(); const dispose = history.subscribe(render);
  return { element: root, dispose };
}

export function installFloorButtons({ history, node, enabled }) {
  const mounted = new Map();
  function mount(element, floor) {
    if (mounted.has(element)) return mounted.get(element).dispose;
    const host = node('div', undefined, 'wsh-floor-host');
    const button = node('button', '◇ 状态', 'wsh-floor-button'); button.type = 'button'; button.title = '查看这一楼的状态记录'; button.setAttribute('aria-expanded', 'false');
    let view;
    button.onclick = () => {
      if (view) { view.dispose(); view.element.remove(); view = null; button.setAttribute('aria-expanded', 'false'); }
      else { history.sync(); view = historyView({ history, node, floor: Number(element.getAttribute('mesid') ?? floor) }); host.append(view.element); button.setAttribute('aria-expanded', 'true'); }
    };
    host.append(button); element.append(host); host.hidden = !enabled();
    const dispose = () => { view?.dispose(); host.remove(); mounted.delete(element); };
    mounted.set(element, { host, dispose }); return dispose;
  }
  const surface = window.__TAURITAVERN__?.api?.chatSurface;
  const managed = surface?.isManagedOwnershipRequired?.() === true;
  if (managed) surface.registerParticipant({ id: 'world-status-hud/floor-records', protocolVersion: surface.protocolVersion, didMount: ({ element, mesid }) => mount(element, mesid) });
  function refresh() {
    if (!managed) {
      for (const [element, item] of mounted) if (!element.isConnected) item.dispose();
      for (const element of document.querySelectorAll('#chat .mes[mesid]')) mount(element, Number(element.getAttribute('mesid')));
    }
    for (const item of mounted.values()) item.host.hidden = !enabled();
  }
  return { refresh };
}
