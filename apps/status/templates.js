import { cloneState, validateTemplate, applyTemplate } from './state-tools.js';

export function createTemplatesPage({ context, settingsKey, read, write, isRunning, node }) {
  const page = node('section', undefined, 'wsh-generation-page');
  page.append(node('h3', '状态栏模板'), node('p', '把已保存的项目、类型和当前值存成模板，可在其他角色聊天中使用。'));
  const name = node('input', undefined, 'text_pole'); name.placeholder = '模板名称'; name.maxLength = 60; name.setAttribute('aria-label', '模板名称');
  const list = node('select', undefined, 'text_pole'); list.setAttribute('aria-label', '已保存模板');
  const preview = node('pre', undefined, 'wsh-template-preview');
  const status = node('p'); status.setAttribute('role', 'status');
  const actions = node('div', undefined, 'wsh-actions');
  const get = () => context().extensionSettings[settingsKey]?.templates || [];
  const persist = templates => {
    const c = context(); c.extensionSettings[settingsKey] = { ...c.extensionSettings[settingsKey], templates }; c.saveSettingsDebounced();
  };
  function selected() { const item = get().find(t => t.id === list.value); if (!item) throw Error('请先选择模板。'); return item; }
  function showPreview() { const t = get().find(t => t.id === list.value); preview.textContent = t ? JSON.stringify(t.state, null, 2) : '还没有模板。'; }
  function render(id = list.value) {
    list.replaceChildren();
    get().forEach(t => { const o = node('option', t.name); o.value = t.id; list.append(o); });
    if (get().some(t => t.id === id)) list.value = id;
    showPreview();
  }
  function button(label, fn) {
    const b = node('button', label, 'menu_button'); b.type = 'button';
    b.onclick = async () => { try { await fn(); } catch (e) { status.textContent = e.message; } }; actions.append(b);
  }
  button('当前状态存为模板', () => {
    const label = name.value.trim(); if (!label) throw Error('请输入模板名称。');
    const state = read(); if (!state) throw Error('当前聊天还没有状态栏。'); validateTemplate(state);
    if (get().some(t => t.name === label)) throw Error('同名模板已存在，请使用其他名称。');
    const item = { id: crypto.randomUUID(), name: label, state: cloneState(state) };
    persist([...get(), item]); render(item.id); status.textContent = '模板已保存，可跨角色使用。';
  });
  async function apply(replace) {
    if (isRunning()) throw Error('请等待模型任务结束后再应用模板。');
    const item = selected();
    if (replace && !confirm('用模板“' + item.name + '”替换当前全部条目和值？当前状态会先备份。')) return;
    const current = read(); await write(applyTemplate(item.state, current, replace));
    status.textContent = replace ? '已替换为模板状态，可返回状态栏查看。' : '已添加模板中缺少的条目，原值保留。';
  }
  button('应用：只补充缺失项', () => apply(false));
  button('应用：替换全部', () => apply(true));
  button('删除模板', () => {
    const item = selected(); if (!confirm('删除模板“' + item.name + '”？已应用到聊天的状态不受影响。')) return;
    persist(get().filter(t => t.id !== item.id)); render(); status.textContent = '模板已删除。';
  });
  list.onchange = showPreview;
  page.append(name, actions, list, preview, status); render(); return page;
}

export async function copyPrompt(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* WebView fallback. */ }
  const d = document.createElement('dialog'), area = document.createElement('textarea'), close = document.createElement('button');
  d.className = 'wsh-restore'; area.className = 'text_pole'; area.value = text; area.readOnly = true; area.style.height = '55vh'; area.style.width = '100%';
  close.textContent = '关闭'; close.className = 'menu_button'; close.onclick = () => d.close(); d.onclose = () => d.remove();
  d.append(document.createTextNode('自动复制不可用，请复制下方已选中的内容。'), area, close);
  document.body.append(d); d.showModal(); area.focus(); area.select(); return false;
}
