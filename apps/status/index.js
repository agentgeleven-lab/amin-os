import { uuid } from '../../uuid.js';
import {mountWorldbookSources} from '../worldbook-source-ui.js';
import {sourceSettings,saveSourceSettings} from '../worldbook-sources.js';
import { createMapLink } from './map-link.js';
import { checkpointState } from './state-checkpoint.js';
import { compileRules, createRulesPage } from './rules.js';
import { installUpdateEntry, boundWorldbook } from './lorebook.js';
import { createHistory } from './history.js';
import { historyView, installFloorButtons, latestStatusFloor } from './history-ui.js';
import { createTemplatesPage, copyPrompt } from './templates.js';
import { buildUpdatePrompt } from './state-tools.js';
import { generateStatus } from './generator.js';
import { setLocalVariable } from '/scripts/variables.js';

const KEY = 'world_status_hud_v1';
const context = () => SillyTavern.getContext();
let embeddedMount, embeddedClose = () => {}, activeIdentity;
export function initialize({mount: target, onClose = () => {}} = {}) { embeddedMount=target; embeddedClose=onClose; mount(); return {open: openEmbedded}; }
async function openEmbedded(page = selectedPage){
  identity();
  if (await floorButtons.openCurrent(page)) { embeddedClose(); return; }
  if (!embeddedMount) { notify('请加载最新聊天楼层，并在设置中显示世界状态按钮。'); return; }
  if (latestStatusFloor(context().chat) < 0) {
    await showHud(page,{target:embeddedMount,emptyChat:true}); return;
  }
  closeHud(); embeddedMount.replaceChildren();
  const notice=node('section',undefined,'amin-page amin-ui wsh-floor-notice');
  const open=node('button','显示入口并打开最新楼层','amin-primary');open.type='button';
  const message=node('p','世界状态已移至楼层窗口。请加载最新消息；编辑器、生成设置、规则和模板都在当前状态工作台中。','amin-notice');
  open.onclick=async()=>{try{context().extensionSettings[KEY]={...context().extensionSettings[KEY],floorButtons:true};context().saveSettingsDebounced();if(await floorButtons.openCurrent(page))embeddedClose();else message.textContent='最新楼层尚未显示，或统一外观中隐藏了世界状态入口。请加载最新消息并在统一外观中开启世界状态按钮后重试。';}catch(e){message.textContent=e.message;}};
  notice.append(message,open);embeddedMount.append(notice);
}
let running = null;
let sessionKey = '';
let hudPanel = null;
let hudEpoch = 0;
let generationForm, formHome, sourceHost, sourcePicker, sourceIdentity, restorePanel;
let selectedPage = 'state';
let selectHudPage = null;
let requestUpdate = null;
let migratingEmptyChat = false;
const defaults = { theme: 'nexus', floorButtons: true, allowTypeChange: false, includePersona: false, baseUrl: '', model: '', includeGlobalBooks: true, extraBooks: '', instructions: '', maxTokens: 4096 };
const getSettings = () => {const legacy={...defaults,...context().extensionSettings[KEY]};return {...legacy,...sourceSettings(context(),'status',{legacyBindings:true,includeGlobalBooks:legacy.includeGlobalBooks,extraBooks:legacy.extraBooks})};};
function refreshSourceControls(){
 if(!sourceHost)return;let id;try{id=identity();}catch{sourcePicker?.dispose();sourcePicker=null;sourceIdentity=null;sourceHost.textContent='请打开单角色聊天后选择世界书';return;}
 if(sourcePicker&&sourceIdentity?.metadata===id.metadata&&sourceIdentity?.id===id.id&&sourceIdentity?.avatar===id.avatar){void sourcePicker.refresh();return;}
 sourcePicker?.dispose();sourceHost.replaceChildren();sourceIdentity=id;sourcePicker=mountWorldbookSources(sourceHost,{context,value:getSettings()});
}
function node(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function notify(message, error = false) { window.toastr?.[error ? 'error' : 'info'](message, '世界状态栏'); }
function identity() {
  const c = context();
  if (c.groupId || !c.characters?.[c.characterId] || c.getCurrentChatId() == null) throw Error('请打开单角色聊天。');
  return { metadata: c.chatMetadata, avatar: c.characters[c.characterId].avatar, id: c.getCurrentChatId() };
}
function checkIdentity(i) {
  const n = identity();
  if (n.metadata !== i.metadata || n.id !== i.id || n.avatar !== i.avatar) throw Error('聊天已切换，请关闭并重新打开面板。');
}
function parseState(raw) {
  if (raw == null || raw === '') return null;
  const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!d || Array.isArray(d) || typeof d.项目 !== 'object' || !d.项目 || Array.isArray(d.项目)) throw Error('状态栏结构不兼容。');
  return d;
}
const history = createHistory({ context, read: () => parseState(context().chatMetadata.variables?.状态栏),
  write: value => { if (value === null) { delete context().chatMetadata.variables?.状态栏; } else setLocalVariable('状态栏', JSON.stringify(value)); },
  beforeRestore: () => { running?.abort(); closeHud(); }, warn: message => notify(message, true) });
const floorButtons = installFloorButtons({ history, node, context, enabled: () => getSettings().floorButtons,
  openWorkbench:(target,{page,onClose,validate})=>showHud(page,{target,onClose,validate}) });
function syncHistory() {
  try {
    history.sync(); floorButtons.refresh();
    if(hudPanel?.dataset.emptyChat==='true'&&latestStatusFloor(context().chat)>=0&&!migratingEmptyChat){
      // MESSAGE_SENT can precede the host's DOM mount. Retain the fallback until
      // the scheduler has observed the new floor, then move the workbench once.
      migratingEmptyChat=true;
      void floorButtons.openCurrent(selectedPage).then(opened=>{if(opened)embeddedClose();}).catch(e=>notify(e.message,true)).finally(()=>{migratingEmptyChat=false;});
    }
  } catch (e) { console.warn('[世界状态栏] 记录同步失败', e); }
}
function createDisplaySettings() {
  const page = node('section', undefined, 'wsh-generation-page');
  const label = node('label', '在楼层工具栏显示世界状态入口'); const input = node('input'); input.type = 'checkbox'; input.checked = getSettings().floorButtons;
  input.onchange = () => { context().extensionSettings[KEY] = { ...context().extensionSettings[KEY], floorButtons: input.checked }; context().saveSettingsDebounced(); floorButtons.refresh(); };
  label.append(input); page.append(node('h3', '显示与记录设置'), label, node('p', '最新楼层打开当前状态工作台，旧楼层打开只读记录。楼层记录随当前聊天自动保存。'), node('p', '翻页仅浏览；删除后续消息、回退剧情时才恢复末尾楼层的变量。没有记录的旧楼层不会自动推测数值。'));
  const appearanceLink=node('button','打开设置 · 统一外观','menu_button');appearanceLink.type='button';appearanceLink.onclick=()=>globalThis.AminOS?.openApp('settings');page.append(appearanceLink,createLorebookControl());
  return page;
}
let writingLorebook = false;
async function writeUpdateWorldbook() {
  if (writingLorebook) throw Error('正在写入世界书，请稍候。');
  const id = identity(); writingLorebook = true;
  try {
    const result = await installUpdateEntry({ context, check: () => checkIdentity(id), extraPrompt: compileRules(context(), KEY, 'update', false) });
    const message = `世界书「${result.name}」：${result.action}“世界状态栏 · 变量更新规则”（UID ${result.uid}）。` + (result.warning || '已设为启用的常驻条目。自动处理模型更新需启用小白X变量管理 2.0。');
    notify(message, !!result.warning); return message;
  } finally { writingLorebook = false; }
}
function createLorebookControl() {
  const section = node('section', undefined, 'wsh-lorebook-control');
  const displayedIdentity = identity();
  let name; try { name = boundWorldbook(context()); } catch { name = '未绑定，请先在角色卡中绑定主世界书'; }
  const button = node('button', '写入世界书更新提示词', 'menu_button'); button.type = 'button';
  const result = node('p', '', 'wsh-quick-status'); result.setAttribute('role', 'status');
  button.onclick = async () => { button.disabled = true; try { checkIdentity(displayedIdentity); if (boundWorldbook(context()) !== name) throw Error('世界书绑定已改变，请重新打开窗口后再写入。'); result.textContent = '正在读取并写入绑定世界书…'; result.textContent = await writeUpdateWorldbook(); } catch (e) { result.textContent = e.message; } finally { button.disabled = false; } };
  section.append(node('h3', '变量更新提示词'), node('p', '当前主世界书：' + name), button, result,
    node('p', '添加常驻条目，动态读取当前“状态栏”变量。重复点击更新本插件条目。其他共用这本世界书的角色也会使用该规则。', 'wsh-note'));
  return section;
}
function closeHud() {
  hudEpoch++;
  hudPanel?.close();
}
async function showHud(page = selectedPage, {target = embeddedMount, onClose = () => {}, validate = () => {}, emptyChat = false} = {}) {
  if (typeof page !== 'string') page = selectedPage;
  closeHud();
  const epoch = hudEpoch;
  const id = identity();
  validate();
  activeIdentity=id;
  const response = await fetch(new URL('./hud.html', import.meta.url));
  if (!response.ok) throw Error('无法加载状态栏界面。');
  let html = await response.text();
  if (epoch !== hudEpoch) return;
  checkIdentity(id);
  validate();
  const dialog = node('section', undefined, 'wsh-workbench wsh-floor-window amin-ui');
  dialog.dataset.emptyChat=String(emptyChat);
  dialog.setAttribute('aria-label','世界状态 · 当前状态工作台');
  const close = node('button', '收起', 'menu_button'); close.type='button';
  const heading = node('div', undefined, 'wsh-panel-heading');
  const title=node('strong','世界状态 · 当前剧情');title.title=context().characters[context().characterId].name+' · 当前状态工作台';
  heading.append(title, close);
  const tabs = node('div', undefined, 'wsh-tabs'); tabs.setAttribute('role', 'tablist');
  const stateTab = node('button', '状态栏', 'wsh-tab');
  const generateTab = node('button', '生成设置', 'wsh-tab');
  const rulesTab = node('button', '状态规则', 'wsh-tab'); rulesTab.id = 'wsh-rules-tab';
  const historyTab = node('button', '楼层记录', 'wsh-tab'); historyTab.id = 'wsh-history-tab';
  const displayTab = node('button', '设置', 'wsh-tab'); displayTab.id = 'wsh-display-tab';
  const templateTab = node('button', '模板', 'wsh-tab'); templateTab.type = 'button'; templateTab.id = 'wsh-template-tab';
  stateTab.type = generateTab.type = 'button';
  stateTab.id = 'wsh-state-tab'; generateTab.id = 'wsh-generate-tab';
  const body = node('div', undefined, 'wsh-body');
  const generationPage = node('section', undefined, 'wsh-generation-page');
  generationPage.id = 'wsh-generation-page'; generationPage.setAttribute('role', 'tabpanel');
  generationPage.setAttribute('aria-labelledby', generateTab.id);
  if (generationForm) generationPage.append(generationForm);
  refreshSourceControls();
  const readCurrent = () => { checkIdentity(id); validate(); return parseState(id.metadata.variables?.状态栏); };
  const templatePage = createTemplatesPage({ context, settingsKey: KEY, read: readCurrent,
    write: async value => {
      checkIdentity(id); validate(); if (running) throw Error('模型任务运行中，请稍后应用模板。');
      const old = id.metadata.variables?.状态栏;
      if (old !== undefined) setLocalVariable('状态栏_生成前备份_' + Date.now(), old);
      setLocalVariable('状态栏', JSON.stringify(value)); checkpointState(context()); history.sync(); await context().saveMetadata();
    }, isRunning: () => !!running, node });
  templatePage.id = 'wsh-template-page'; templatePage.setAttribute('role', 'tabpanel'); templatePage.setAttribute('aria-labelledby', templateTab.id);
  templateTab.setAttribute('aria-controls', templatePage.id);
  const frame = node('iframe');
  let readyHtml = '', frameLoaded = false;
  frame.id = 'wsh-state-page'; frame.setAttribute('role', 'tabpanel'); frame.setAttribute('aria-labelledby', stateTab.id);
  stateTab.setAttribute('aria-controls', frame.id); generateTab.setAttribute('aria-controls', generationPage.id);
  history.sync();
  const recordsView = historyView({ history, node });
  const historyPage = recordsView.element; historyPage.id = 'wsh-history-page';
  const rulesPage = createRulesPage({ context, settingsKey: KEY, node, check: () => {checkIdentity(id);validate();}, syncWorldbook: writeUpdateWorldbook }); rulesPage.id = 'wsh-rules-page';
  const displayPage = createDisplaySettings(); displayPage.id = 'wsh-display-page';
  for (const [tab, page] of [[historyTab, historyPage], [displayTab, displayPage], [rulesTab, rulesPage]]) { tab.type = 'button'; tab.setAttribute('aria-controls', page.id); page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', tab.id); }
  rulesTab.onclick = () => selectPage('rules');
  historyTab.onclick = () => selectPage('history'); displayTab.onclick = () => selectPage('display');
  function selectPage(value) {
    if (value === undefined) value = selectedPage;
    selectedPage = ['generate', 'templates', 'history', 'display', 'rules'].includes(value) ? value : 'state';
    if (selectedPage === 'state' && readyHtml && !frameLoaded) { frame.srcdoc = readyHtml; frameLoaded = true; }
    rulesPage.hidden = selectedPage !== 'rules';
    historyPage.hidden = selectedPage !== 'history'; displayPage.hidden = selectedPage !== 'display';
    frame.hidden = selectedPage !== 'state'; generationPage.hidden = selectedPage !== 'generate'; templatePage.hidden = selectedPage !== 'templates';
    for (const [b, name] of [[stateTab, 'state'], [generateTab, 'generate'], [templateTab, 'templates'], [historyTab, 'history'], [displayTab, 'display'], [rulesTab, 'rules']]) {
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(selectedPage === name));
      b.tabIndex = selectedPage === name ? 0 : -1;
    }
  }
  stateTab.onclick = () => selectPage('state'); generateTab.onclick = () => selectPage('generate'); templateTab.onclick = () => selectPage('templates');
  tabs.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const pages = ['state', 'generate', 'templates', 'rules', 'history', 'display']; const i = pages.indexOf(selectedPage);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? 5 : (i + (e.key === 'ArrowRight' ? 1 : 5)) % 6;
    selectPage(pages[j]); [stateTab, generateTab, templateTab, rulesTab, historyTab, displayTab][j].focus();
  });
  selectHudPage = selectPage; tabs.append(stateTab, generateTab, templateTab, rulesTab, historyTab, displayTab); body.append(frame, generationPage, templatePage, historyPage, displayPage, rulesPage); selectPage(page);
  frame.title = '世界状态栏编辑器';
  // Only the bundled frame may use this variable bridge; commands are allowlisted.
  const token = uuid();
  const bridge = `<script>
  window.WSH_CARD_KEY=${JSON.stringify(encodeURIComponent(context().characters[context().characterId].avatar || 'current'))};
  const token=${JSON.stringify(token)};let seq=0;const pending=new Map();
  window.STscript=command=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error('连接超时，请重新打开面板。'))},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({wsh:token,id,command},'*')});
  addEventListener('message',e=>{if(e.source!==parent||e.data?.wsh!==token)return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.value)});
  <\/script>`;
  html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-wsh-frame data-wsh-theme="nexus">');
  html = html.replace('</head>', '<link rel="stylesheet" href="' + new URL('./themes.css', import.meta.url).href + '"></head>');
  html=html.replace('</head>','<link rel="stylesheet" href="'+new URL('../../ui-status.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('../../settings/appearance-frame.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('../../ui/standard.css',import.meta.url).href+'"><link rel="stylesheet" href="'+new URL('./workbench-frame.css',import.meta.url).href+'"></head>');
  html = html.replace('<head>', '<head>' + bridge);
  const listener = event => {
    if (event.source !== frame.contentWindow || event.data?.wsh !== token) return;
    const { command, id: requestId } = event.data;
    try {
      checkIdentity(id);
      validate();
      let value;
      if (command === '/getvar 状态栏') value = parseState(id.metadata.variables?.状态栏);
      else if (typeof command === 'string' && command.startsWith('/setvar key=状态栏 ')) {
        if (running) throw Error('状态栏生成中，请完成后再编辑。');
        value = parseState(command.slice('/setvar key=状态栏 '.length));
        if (!value) throw Error('不能写入空状态。');
        setLocalVariable('状态栏', JSON.stringify(value)); checkpointState(context()); history.sync();
      } else throw Error('不支持的状态栏命令。');
      event.source.postMessage({ wsh: token, id: requestId, value }, '*');
    } catch (e) { event.source.postMessage({ wsh: token, id: requestId, error: e.message }, '*'); }
  };
  addEventListener('message', listener);
  let closed=false;
  dialog.close=()=>{if(closed)return;closed=true;recordsView.dispose();removeEventListener('message',listener);frame.srcdoc='';restorePanel?.remove();restorePanel=null;if(generationForm?.parentElement===generationPage)formHome?.append(generationForm);dialog.remove();mapLink.destroy();if(hudPanel===dialog){hudPanel=null;selectHudPage=null;}onClose();};
  close.onclick = closeHud;
  const quickActions = node('div', undefined, 'wsh-actions');
  const quickStatus = node('p', '', 'wsh-quick-status'); quickStatus.setAttribute('role', 'status');
  const update = node('button', '按剧情更新', 'menu_button amin-primary'); update.type = 'button'; update.title='根据近期对话更新当前状态值';
  update.onclick = async () => {
    try { checkIdentity(id); validate(); update.disabled = true; quickStatus.textContent = '正在读取近期对话并更新…';
      const result = await requestUpdate(); checkIdentity(id);
      quickStatus.textContent = result?.ok ? (result.changed ? '数值已更新。' : '无需更新。') : result?.message || '更新未完成，请查看生成设置。';
    } catch (e) { quickStatus.textContent = e.message; } finally { update.disabled = false; }
  };
  const copy = node('button', '复制更新提示词', 'menu_button'); copy.type = 'button'; copy.title='复制当前状态、字段路径和模型更新要求';
  copy.onclick = async () => {
    try { const text = buildUpdatePrompt(readCurrent()) + '\n\n' + compileRules(context(), KEY, 'update').replaceAll('<', '＜').replaceAll('>', '＞'); const ok = await copyPrompt(text,{mount:dialog}); quickStatus.textContent = ok ? '已复制当前变量、路径与更新要求，可粘贴到对话。' : '请在工作台下方的文本框中手动复制。'; }
    catch (e) { quickStatus.textContent = e.message; }
  };
  quickActions.append(update, copy);
  const mapLink=createMapLink({check:()=>{checkIdentity(id);validate();}});
  dialog.append(heading,node('p',emptyChat?'当前聊天还没有消息，暂在这里编辑；发送第一条消息后，从最新楼层继续。':'编辑将更新当前剧情状态，历史快照仅供浏览。','wsh-workbench-note'), tabs, quickActions, quickStatus, body);
  displayPage.append(mapLink.element);
  if(emptyChat)target.replaceChildren();
  target.append(dialog);
  if(emptyChat)dialog.classList.add('amin-status-embedded');
  hudPanel = dialog; readyHtml = html; selectPage(selectedPage);
  return {element:dialog,selectPage,dispose:()=>dialog.close()};
}
async function restoreBackup() {
  if (running) throw Error('请先等待生成结束。');
  const id = identity();
  const backups = Object.keys(id.metadata.variables || {}).filter(k => k.startsWith('状态栏_生成前备份_')).sort().reverse();
  const candidates = new Map(backups.map(k => [k, id.metadata.variables[k]]));
  for (const row of history.list()) { if (row.available && row.state) candidates.set(`楼层记录 · 第 ${row.index + 1} 楼 · ${row.name}`, JSON.stringify(row.state)); }
  if (!candidates.size) throw Error('当前聊天没有备份或楼层记录。');
  restorePanel?.remove();
  const d = node('section', undefined, 'wsh-restore amin-card'); restorePanel=d;
  d.setAttribute('aria-label','恢复状态栏备份');
  d.close=()=>{d.remove();if(restorePanel===d)restorePanel=null;};
  const title = node('h3', '恢复状态栏备份');
  const select = node('select', undefined, 'text_pole');
  [...candidates.keys()].forEach(k => { const o = node('option', k); o.value = k; select.append(o); });
  const restore = node('button', '恢复所选备份', 'menu_button');
  const cancel = node('button', '取消', 'menu_button');
  const result = node('p');
  restore.onclick = async () => {
    try {
      checkIdentity(id);
      if (running) throw Error('生成正在运行，请稍后恢复。');
      const restored = parseState(candidates.get(select.value));
      if (!restored) throw Error('备份为空。');
      const current = id.metadata.variables.状态栏;
      if (current !== undefined) setLocalVariable('状态栏_生成前备份_' + Date.now(), current);
      setLocalVariable('状态栏', JSON.stringify(restored)); checkpointState(context());
      await context().saveMetadata(); d.close(); notify('已恢复，恢复前的状态也已备份。');
    } catch (e) { result.textContent = e.message; }
  };
  cancel.onclick = () => d.close();
  d.append(title, node('p', '恢复会用所选完整状态覆盖当前值，并先备份当前状态。楼层记录只在点击恢复后才应用；不会回退聊天正文。'), select, restore, cancel, result); generationForm.append(d); d.scrollIntoView({block:'nearest'}); select.focus({preventScroll:true});
}
function mount() {
  if (generationForm) return;
  // Keep the shared form detached while the floor workbench is closed.
  formHome = node('div');
  generationForm = node('div', undefined, 'wsh-generation-form');
  generationForm.append(node('h3', '按设定生成状态栏'), node('p', '读取当前角色卡与关联世界书，生成后可切回“状态栏”查看。'));
  const fields = {};
  function field(key, label, type = 'text') {
    const wrap = node('label', label);
    const input = node(type === 'textarea' ? 'textarea' : 'input', undefined, 'text_pole');
    if (type !== 'textarea') input.type = type;
    fields[key] = input; wrap.append(input); generationForm.append(wrap); return input;
  }
  const settings = getSettings();
  const sharedSettings=document.createElement('button');sharedSettings.type='button';sharedSettings.textContent='AI 设置 · 全局 API 与预设';sharedSettings.onclick=()=>globalThis.AminOS?.openApp('ai');generationForm.append(sharedSettings);
  sourceHost=node('div');generationForm.append(sourceHost);refreshSourceControls();
  field('includePersona', '读取用户设定描述（Persona）', 'checkbox');
  generationForm.append(node('p','默认不读取用户设定。勾选后每次读取当前用户名称与Persona描述，独立于角色资料和世界书；没有描述时提示补充。','wsh-note'));
  field('updateNote', '当前情况补充（更新数值时使用，可留空）', 'textarea');
  field('allowTypeChange', '允许更改已有字段类型（默认关闭，仅用于 AI 更新）', 'checkbox');
  generationForm.append(node('p','未勾选时保留原类型。可在当前情况补充或状态栏要求中明确填写“把体力改为数字”，仅授权指定字段；填写“允许更改已有字段类型”可授权本次更新中的类型转换。'));
  field('instructions', '状态栏要求', 'textarea').placeholder = '例如：仅显示玩家、世界、队伍；不要数值化感情。';
  Object.entries(settings).forEach(([k,v]) => { if (fields[k]) fields[k].type === 'checkbox' ? fields[k].checked = v : fields[k].value = v; });
  const report = node('p', '准备就绪。', 'wsh-report'); report.setAttribute('role', 'status');
  function save() {
    const s = {};
    for (const [k,input] of Object.entries(fields)) {
      if (k === 'apiKey') { sessionKey = input.value; continue; }
      s[k] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    }
    if(!sourcePicker)throw Error('请先打开单角色聊天');const sources=sourcePicker.getValue();saveSourceSettings(context(),'status',sources);
    context().extensionSettings[KEY] = { ...context().extensionSettings[KEY], ...s }; context().saveSettingsDebounced(); return {...s,...sources};
  }
  const actions = node('div', undefined, 'wsh-actions');
  function action(label, fn) {
    const b = node('button', label, 'menu_button'); b.type = 'button';if(['保存配置','生成／补充'].includes(label))b.classList.add('amin-primary');
    b.onclick = async () => { try { await fn(); } catch (e) { report.textContent = e.message; notify(e.message, true); } }; actions.append(b); return b;
  }
  const saveButton = action('保存配置', () => { save(); report.textContent = '状态栏配置已保存；模型与预设在 AI 设置中管理。'; });
  async function generate(mode) {
    if (running) throw Error('生成任务已经运行。');
    if (mode === 'replace' && !confirm('重新生成将替换当前状态栏全部项目，操作前会备份。继续？')) return;
    const s = save(); identity();
    running = new AbortController(); report.textContent = '正在读取设定并请求模型…';
    generateButton.disabled = replaceButton.disabled = saveButton.disabled = true;
    try {
      const result = await generateStatus({ api: { baseUrl: s.baseUrl, apiKey: sessionKey, model: s.model, timeoutMs: 120000, maxTokens: s.maxTokens }, mode,
        includePersona:s.includePersona===true,includeCharacter:s.includeCharacter,readWorldbooks:s.readWorldbooks,selectedBooks:s.selectedBooks,legacyBindings:true,includeGlobalBooks:s.includeGlobalBooks,extraBooks:s.extraBooks,
        allowTypeChange:s.allowTypeChange===true, updateNote: s.updateNote || '', instructions: s.instructions || '根据世界观设计简洁实用的状态栏。', statusRules: compileRules(context(), KEY, mode === 'update' ? 'update' : 'generate') }, running.signal);
      report.textContent = result.ok ? (result.changed ? '操作完成，可打开状态栏查看。' : '没有需要修改的内容。') + ' 读取世界书：' + (result.books?.join('、') || '无') : result.message || '已有任务运行中。';
      return result;
    } finally { syncHistory(); running = null; generateButton.disabled = replaceButton.disabled = saveButton.disabled = false; }
  }
  requestUpdate = () => generate('update');
  action('按当前剧情更新值', requestUpdate);
  const generateButton = action('生成／补充', () => generate('fill'));
  const replaceButton = action('重新生成整套', () => generate('replace'));
  action('取消生成', () => { running?.abort(); report.textContent = '已请求取消，等待底层调用返回；结果不会写入。'; });
  action('查看状态栏', () => selectHudPage ? selectHudPage('state') : openEmbedded('state'));
  action('恢复备份', restoreBackup);
  action('写入世界书更新提示词', async () => { report.textContent = await writeUpdateWorldbook(); });
  generationForm.append(actions, report, node('p', '独立接口使用 Chat Completions 格式，需要允许浏览器跨域。生成与编辑共用聊天变量“状态栏”。', 'wsh-note'));
  formHome.append(generationForm);

  syncHistory();
  const ctx = context(); const events = ctx.eventTypes || ctx.event_types || {};
  for (const name of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'GENERATION_ENDED', 'CHARACTER_MESSAGE_RENDERED']) { if (events[name]) ctx.eventSource?.on(events[name], syncHistory); }
  setInterval(() => {
    if(hudPanel){try{checkIdentity(activeIdentity);}catch{running?.abort();closeHud();}}
    syncHistory();
  }, 750);
  if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,()=>{running?.abort();closeHud();refreshSourceControls();});
}
