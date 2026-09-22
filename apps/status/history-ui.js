import {mountFloorControl} from '../../settings/floor-layout.js';
import {observeChatFloors} from '../floor-scheduler.js';
export function historyView({ history, node, floor = null }) {
  const root = node('section', undefined, 'wsh-history');
  const nav = node('div', undefined, 'wsh-history-nav');
  const left = node('button', '‹'), right = node('button', '›'), latest = node('button', '最新记录');
  left.title = '上一楼'; right.title = '下一楼';
  const label = node('span'); const body = node('div',undefined,'wsh-history-grid');
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

// The editable workbench belongs to the current conversation, never to an old snapshot.
export function latestStatusFloor(chat = []) {
  for (let index = chat.length - 1; index >= 0; index--) if (!chat[index]?.is_system) return index;
  return -1;
}

export function installFloorButtons({ history, node, enabled = () => true,
  context = () => globalThis.SillyTavern?.getContext?.(), openWorkbench,
  root = globalThis.document, surface = globalThis.__TAURITAVERN__?.api?.chatSurface, observe = observeChatFloors }) {
  const mounted = new Map(), owned = new Set();
  const managed = surface?.isManagedOwnershipRequired?.() === true;
  let disposed = false, rendered = [];
  const currentIdentity = c => ({metadata:c?.chatMetadata,id:c?.getCurrentChatId?.(),avatar:c?.characters?.[c?.characterId]?.avatar});
  const sameIdentity = (a,b) => a.metadata === b.metadata && a.id === b.id && a.avatar === b.avatar;
  function mount(element) {
    if (disposed || mounted.has(element)) return;
    const c = context(), floor = Number(element.getAttribute('mesid')), message = c?.chat?.[floor], identity = currentIdentity(c);
    if (!message || message.is_system || c.groupId || identity.id == null || !c.characters?.[c.characterId]) return;
    const variant = String(message.swipe_id ?? 0);
    const host = node('div', undefined, 'wsh-floor-host');
    const button = node('button', '◇ 世界状态', 'wsh-floor-button'); button.type = 'button'; button.setAttribute('aria-expanded', 'false');
    const dock = mountFloorControl(element, 'status', host, button, root);
    let view = null, mode = null, revision = 0, pending = null;
    const isCurrent = () => latestStatusFloor(context()?.chat) === floor;
    const isValid = () => !context()?.groupId && sameIdentity(identity,currentIdentity(context())) && context()?.chat?.[floor] === message &&
      String(message.swipe_id ?? 0) === variant && Number(element.getAttribute('mesid')) === floor && element.isConnected;
    function validate() {
      if (!isValid() || !isCurrent()) throw Error('当前楼层已变化，请重新打开最新楼层的状态工作台。');
    }
    function close() {
      revision++; const previous = view; view = null; mode = null; pending = null;
      previous?.dispose?.(); host.replaceChildren(); dock.setOpen(false); button.setAttribute('aria-expanded', 'false');
    }
    async function open(kind = isCurrent() ? 'current' : 'history', page) {
      if (!isValid()) return false;
      if (mode === 'current' && kind === 'current') { view?.selectPage?.(page); return pending ?? true; }
      close(); history.sync();
      if (!isValid()) return false;
      mode = kind; const ticket = revision;
      dock.setOpen(true); button.setAttribute('aria-expanded', 'true');
      if (kind === 'current' && openWorkbench) {
        host.append(node('p', '正在打开当前状态工作台…', 'amin-notice'));
        pending = (async () => {
          try {
            validate();
            const workbench = await openWorkbench(host, {page, onClose:()=>{if(ticket===revision)close();}, validate});
            if (ticket !== revision || !isValid() || !isCurrent()) { workbench?.dispose?.(); return false; }
            if (!workbench) { close(); return false; }
            // Keep an already mounted iframe in place: reparenting reloads its document.
            for (const child of [...host.children]) if (child !== workbench.element) child.remove();
            if (workbench.element.parentElement !== host) host.append(workbench.element);
            view = workbench; pending = null; return true;
          } catch (error) {
            if (ticket !== revision) return false;
            close(); const notice = node('p', error.message, 'amin-notice'); notice.setAttribute('role','alert'); host.append(notice); return false;
          }
        })();
        return pending;
      }
      const frame = node('section',undefined,'wsh-floor-window amin-ui'), heading = node('header',undefined,'wsh-floor-heading');
      const collapse = node('button','收起'); collapse.type='button'; collapse.onclick=close;
      heading.append(node('strong',`世界状态 · 第 ${floor+1} 楼记录`),collapse);
      const current = node('button','打开当前状态工作台','amin-primary wsh-open-current');current.type='button';current.onclick=()=>{void openCurrent();};
      const record = historyView({history,node,floor});
      frame.append(heading,node('p','正在浏览历史快照。编辑、生成、规则和模板请前往当前状态工作台。','amin-notice'),current,record.element);
      host.append(frame);view={element:frame,dispose:record.dispose};return true;
    }
    button.onclick = () => { if (mode) close(); else void open(); };
    const dispose = () => { close(); dock.dispose(); mounted.delete(element); };
    const refresh = () => {
      if (!isValid()) { dispose(); return; }
      if (mode === 'current' && !isCurrent()) close();
      button.title = isCurrent() ? '编辑当前状态、生成设置、规则、模板和楼层记录' : '只读查看这一楼的状态记录';
      button.dataset.statusMode = isCurrent() ? 'current' : 'history';
      dock.setVisible(enabled() !== false);
    };
    mounted.set(element,{host,button,dock,dispose,refresh,open,floor}); refresh();
  }
  const unregister = managed ? surface.registerParticipant({id:'world-status-hud/floor-records',protocolVersion:surface.protocolVersion,
    didMount:({element})=>{owned.add(element);mount(element);return ()=>{owned.delete(element);mounted.get(element)?.dispose();};}}) : null;
  function refresh(elements) {
    if (disposed) return;
    if (Array.isArray(elements)) rendered = elements;
    for (const item of [...mounted.values()]) item.refresh();
    for (const element of managed ? owned : rendered) mount(element);
  }
  const scheduler = observe(refresh,{document:root,getContext:context});
  async function openCurrent(page) {
    history.sync(); refresh();
    const index = latestStatusFloor(context()?.chat);
    const item = [...mounted.values()].find(item => item.floor === index && !item.button.hidden);
    if (!item) return false;
    const opened = await item.open('current',page);
    if (opened) { item.host.scrollIntoView?.({block:'nearest',behavior:'smooth'}); item.host.querySelector?.('button')?.focus?.({preventScroll:true}); }
    return opened;
  }
  return {refresh,openCurrent,dispose(){disposed=true;scheduler.dispose();for(const item of [...mounted.values()])item.dispose();owned.clear();if(typeof unregister==='function')unregister();}};
}
