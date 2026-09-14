export const THEMES = [
  { id: 'nexus', name: '星港青蓝', note: '深色科技 HUD · 青蓝与暖金' },
  { id: 'sakura', name: '樱花物语', note: '柔和视觉小说 · 浅粉与莓红' },
  { id: 'parchment', name: '旅人手记', note: '奇幻冒险 · 纸色与古铜' },
  { id: 'amethyst', name: '深海紫晶', note: '夜色幻想 · 靛紫与星光' },
  { id: 'mono', name: '极简墨白', note: '清爽阅读 · 白底与石墨' },
];
export const normalizeTheme = id => THEMES.some(t => t.id === id) ? id : 'nexus';
export function applyTheme(document, id) {
  const theme = normalizeTheme(id);
  document.documentElement.setAttribute('data-wsh-theme', theme);
  // Change only styling in the existing frame: preserve unsaved editor drafts.
  for (const frame of document.querySelectorAll('.wsh-dialog iframe')) {
    try { frame.contentDocument?.documentElement?.setAttribute('data-wsh-theme', theme); } catch { /* Frame not ready yet. */ }
  }
  return theme;
}
export function createThemePicker({ node, context, settingsKey, document }) {
  const section = node('section', undefined, 'wsh-theme-section');
  section.append(node('h3', '界面主题'), node('p', '点击预览并自动保存；悬浮窗口、编辑器和楼层记录一起切换。', 'wsh-note'));
  const choices = node('div', undefined, 'wsh-theme-grid');
  const buttons = [];
  function select(id) {
    for (const [button, theme] of buttons) button.setAttribute('aria-pressed', String(theme === id));
  }
  for (const theme of THEMES) {
    const button = node('button', undefined, 'wsh-theme-choice'); button.type = 'button';
    button.setAttribute('data-wsh-palette', theme.id);
    button.append(node('span', theme.name, 'wsh-theme-name'), node('span', theme.note, 'wsh-theme-note'));
    const sample = node('span', undefined, 'wsh-theme-sample'); sample.append(node('span', '生命 76 / 100'), node('span', '● 同行中'));
    button.append(sample);
    button.onclick = () => {
      const ctx = context(); ctx.extensionSettings[settingsKey] = { ...ctx.extensionSettings[settingsKey], theme: theme.id };
      applyTheme(document, theme.id); select(theme.id); ctx.saveSettingsDebounced();
    };
    buttons.push([button, theme.id]); choices.append(button);
  }
  select(normalizeTheme(context().extensionSettings[settingsKey]?.theme)); section.append(choices); return section;
}
export const STYLES = [
  {id:'paper',name:'古典书页',note:'小圆角 · 双线边框 · 衬线标题'},
  {id:'tech',name:'切角科技',note:'斜切卡片 · 细网格 · 高亮边线'},
  {id:'dossier',name:'角色档案',note:'直角 · 编号标题 · 装订边'},
  {id:'terminal',name:'终端面板',note:'直角线框 · 等宽字体 · 终端标记'},
  {id:'flat',name:'极简平面',note:'弱化边框 · 清爽留白 · 细分隔线'},
];
export const normalizeStyle = id => STYLES.some(s=>s.id===id)?id:'paper';
export function applyStyle(document,id){
  const style=normalizeStyle(id);document.documentElement.setAttribute('data-wsh-style',style);
  for(const frame of document.querySelectorAll('.wsh-dialog iframe')){try{frame.contentDocument?.documentElement?.setAttribute('data-wsh-style',style);}catch{}}
  return style;
}
export function createStylePicker({node,context,settingsKey,document}){
  const section=node('section',undefined,'wsh-style-section'),grid=node('div',undefined,'wsh-theme-grid'),buttons=[];
  section.append(node('h3','面板款式'),node('p','款式决定边框、底纹与排版，可与任意配色搭配。默认使用古典书页的小圆角。','wsh-note'));
  function select(id){for(const [button,key]of buttons)button.setAttribute('aria-pressed',String(id===key));}
  for(const style of STYLES){
    const button=node('button',undefined,'wsh-style-choice');button.type='button';button.setAttribute('data-wsh-style-preview',style.id);
    button.append(node('strong',style.name),node('span',style.note,'wsh-theme-note'));
    button.onclick=()=>{const ctx=context();ctx.extensionSettings[settingsKey]={...ctx.extensionSettings[settingsKey],panelStyle:style.id};applyStyle(document,style.id);select(style.id);ctx.saveSettingsDebounced();};
    grid.append(button);buttons.push([button,style.id]);
  }
  select(normalizeStyle(context().extensionSettings[settingsKey]?.panelStyle));section.append(grid);return section;
}
export function glassSettings(settings={}) {
  return {enabled:settings.glassEnabled===true,transparency:Number.isFinite(settings.glassTransparency)?Math.max(10,Math.min(80,settings.glassTransparency)):35};
}
export function applyGlass(document,settings){
  const glass=glassSettings(settings);
  function apply(doc){doc.documentElement.setAttribute('data-wsh-glass',glass.enabled?'on':'off');doc.documentElement.style.setProperty('--wsh-glass-opacity',(100-glass.transparency)+'%');}
  apply(document);for(const frame of document.querySelectorAll('.wsh-dialog iframe')){try{if(frame.contentDocument)apply(frame.contentDocument);}catch{}}
}
export function createGlassSettings({node,context,settingsKey,document}){
  const section=node('section'),title=node('h3','毛玻璃窗口'),label=node('label','启用半透明与背景模糊'),toggle=node('input'),rangeLabel=node('label','背景透明度'),range=node('input'),value=node('span');
  const initial=glassSettings(context().extensionSettings[settingsKey]);toggle.type='checkbox';toggle.checked=initial.enabled;range.type='range';range.min='10';range.max='80';range.step='5';range.value=initial.transparency;range.disabled=!initial.enabled;value.textContent=initial.transparency+'%';
  function save(){const ctx=context();const s={...ctx.extensionSettings[settingsKey],glassEnabled:toggle.checked,glassTransparency:Number(range.value)};ctx.extensionSettings[settingsKey]=s;range.disabled=!toggle.checked;value.textContent=range.value+'%';applyGlass(document,s);ctx.saveSettingsDebounced();}
  toggle.onchange=save;range.oninput=save;label.append(toggle);rangeLabel.append(range,value);section.append(title,label,rangeLabel,node('p','透明度越高，聊天背景越明显。文字保持清晰；关闭可恢复实心背景。','wsh-note'));return section;
}
