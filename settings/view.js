import {resetTileLayout} from '../tile-layout.js';
import {getAppearance,PALETTES,APP_NAMES,defaults} from './appearance.js';
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
export function mount(target){
 const service=getAppearance();target.classList.add('amin-ai','amin-settings');let page='global';
 function draw(){
  const draft=service.snapshot();target.replaceChildren(el('h2','设置'),el('p','统一窗口与应用外观。应用默认跟随全局，也可以设置自己的风格。'));
  const nav=el('nav'),body=el('section'),notice=el('p');notice.setAttribute('role','status');target.append(nav,body,notice);
  const button=(parent,label,fn)=>{const e=el('button',label);e.type='button';e.onclick=()=>{try{fn();}catch(error){notice.textContent=error.message;}};parent.append(e);return e;};
  for(const [id,name]of [['global','整体外观'],['apps','单个应用'],['floor','楼层窗口'],['effects','背景与动效']]){const b=button(nav,name,()=>{page=id;draw();});b.setAttribute('aria-pressed',String(page===id));}
  function select(parent,label,items,value,onchange){const wrap=el('label',label),control=el('select');for(const [id,name]of items){const o=el('option',name);o.value=id;control.append(o);}control.setAttribute('aria-label',label);control.value=value;control.onchange=()=>onchange(control.value);wrap.append(control);parent.append(wrap);return control;}
  function numeric(parent,label,value,min,max,onchange){const wrap=el('label',`${label}（${min}–${max}）`),control=el('input');control.type='number';control.min=min;control.max=max;control.value=value;control.oninput=()=>onchange(Number(control.value));wrap.append(control);parent.append(wrap);}
  function fields(parent,value){
   select(parent,'主题',Object.entries(PALETTES).map(([id,p])=>[id,p.name]),value.theme,v=>value.theme=v);
   numeric(parent,'字号',value.fontSize,11,20,v=>value.fontSize=v);numeric(parent,'圆角',value.radius,0,24,v=>value.radius=v);
   select(parent,'内容间距',[['comfortable','舒适'],['compact','紧凑']],value.density,v=>value.density=v);
   numeric(parent,'背景不透明度 %',value.opacity,70,100,v=>value.opacity=v);numeric(parent,'背景模糊',value.blur,0,24,v=>value.blur=v);
  }
  if(page==='global'){
   select(body,'主页磁贴风格',[['classic','风格 1 · 跟随主题'],['win10','风格 2 · Windows 10']],draft.desktop.style,v=>draft.desktop.style=v);select(body,'窗口主题',[['auto','自动搭配磁贴风格'],['current','保留原有主题'],['win10','Windows 10 深色'],['win10light','Windows 10 浅色']],draft.desktop.windowTheme,v=>draft.desktop.windowTheme=v);body.append(el('p','自动模式为 Windows 10 磁贴搭配深色直角窗口；单独设置过外观的应用保留自己的主题。'));
   button(body,'恢复磁贴默认布局',()=>{resetTileLayout();notice.textContent='磁贴已恢复默认顺序和尺寸。';});fields(body,draft.global);body.append(el('h3','侧栏尺寸'),el('p','屏幕空间不足时自动缩小；位置保持在可见范围内。'));
   numeric(body,'桌面侧栏宽度',draft.window.width,340,800,v=>draft.window.width=v);numeric(body,'侧栏最大高度',draft.window.height,400,1000,v=>draft.window.height=v);
  }else if(page==='apps'){
   for(const [id,name]of Object.entries(APP_NAMES)){
    const card=el('details');card.className='amin-appearance-card';card.append(el('summary',name));const content=el('div');card.append(content);body.append(card);
    const choice=select(content,'外观来源',[['inherit','跟随全局'],['own','使用单独外观']],draft.apps[id]?'own':'inherit',value=>{if(value==='own')draft.apps[id]={...draft.global};else delete draft.apps[id];render();});
    const editor=el('div');content.append(editor);const render=()=>{editor.replaceChildren();if(draft.apps[id])fields(editor,draft.apps[id]);else editor.append(el('p','全局外观变化会自动应用到这里。'));};render();
   }
  }else if(page==='effects'){
   const d=draft.desktop.effects;
   const text=(label,key)=>{const wrap=el('label',label),input=el('input');input.type='url';input.value=d[key];input.setAttribute('aria-label',label);input.oninput=()=>d[key]=input.value;wrap.append(input);body.append(wrap);};
   select(body,'主页背景',[['none','跟随主题'],['paper','纸页纹理'],['aurora','极光山影'],['image','自定义图片']],d.preset,v=>d.preset=v);
   text('主页背景图片地址','image');numeric(body,'背景遮罩深浅 %',d.shade,0,90,v=>d.shade=v);
   numeric(body,'磁贴不透明度 %',d.tileOpacity,15,100,v=>d.tileOpacity=v);numeric(body,'磁贴边框',d.border,0,3,v=>d.border=v);numeric(body,'磁贴阴影',d.shadow,0,30,v=>d.shadow=v);
   select(body,'磁贴区域动态效果',[['none','关闭'],['sakura','樱花飘落'],['video','自定义视频层']],d.effect,v=>d.effect=v);
   text('视频地址','video');numeric(body,'樱花数量',d.amount,4,50,v=>d.amount=v);numeric(body,'飘落时长（秒，越大越慢）',d.speed,4,30,v=>d.speed=v);numeric(body,'动态层不透明度 %',d.effectOpacity,5,100,v=>d.effectOpacity=v);
   body.append(el('p','填写可直接访问的图片或视频地址，也支持 / 开头的酒馆资源路径。视频静音循环，加载依赖资源服务器。动效只覆盖磁贴区域，文字与图标在上层；编辑布局、收起窗口或系统要求减少动态时暂停。单块磁贴背景在主页编辑布局中设置。'));
  }else{
   body.append(el('p','各应用楼层窗口默认共用下列尺寸，按钮紧邻排列。先打开的窗口排在上面；关闭后再打开会排到末尾。'));
   for(const [id,name]of [['map','地图'],['status','状态'],['reply','回复选项'],['effects','能力面板'],['information','信息面板']]){const row=el('label'),check=el('input');check.type='checkbox';check.checked=draft.floor.buttons[id];check.onchange=()=>draft.floor.buttons[id]=check.checked;row.append(check,document.createTextNode('显示'+name+'楼层按钮'));body.append(row);}
   select(body,'按钮与窗口对齐',[['left','靠左'],['center','居中'],['right','靠右']],draft.floor.alignment,v=>draft.floor.alignment=v);
   select(body,'窗口高度',[['fixed','统一高度'],['auto','随内容变化（不超过上限）']],draft.floor.sizeMode,v=>draft.floor.sizeMode=v);
   const dimensions=(parent,value)=>{numeric(parent,'桌面最大宽度',value.width,320,1400,v=>value.width=v);numeric(parent,'桌面高度（占屏幕 %）',value.desktopHeight,30,90,v=>value.desktopHeight=v);numeric(parent,'手机高度（占屏幕 %）',value.mobileHeight,30,85,v=>value.mobileHeight=v);};
   dimensions(body,draft.floor);
   for(const [id,name]of [['map','地图窗口'],['status','状态窗口'],['reply','回复选项窗口'],['effects','能力面板窗口'],['information','信息面板窗口']]){const card=el('details');card.append(el('summary',name));body.append(card);const editor=el('div');select(card,'尺寸来源',[['inherit','跟随统一尺寸'],['own','单独设置']],draft.floor.overrides[id]?'own':'inherit',v=>{if(v==='own')draft.floor.overrides[id]={width:draft.floor.width,desktopHeight:draft.floor.desktopHeight,mobileHeight:draft.floor.mobileHeight};else delete draft.floor.overrides[id];render();});card.append(editor);const render=()=>{editor.replaceChildren();if(draft.floor.overrides[id])dimensions(editor,draft.floor.overrides[id]);};render();}
   body.append(el('p','窗口不会超过消息宽度。地图圆角跟随全局或地图的独立外观，状态内容保持原布局。'));

  }
  button(body,'保存并应用',()=>{service.save(draft);notice.textContent='已应用。打开的窗口同步更新，编辑内容会保留。';}).className='amin-primary';
  button(body,'恢复本页默认',()=>{const next=service.snapshot(),d=defaults();if(page==='global'){next.global=d.global;next.window=d.window;next.desktop=d.desktop;}else if(page==='apps')next.apps={};else if(page==='effects')next.desktop.effects=d.desktop.effects;else next.floor=d.floor;service.save(next);draw();});
 }
 draw();return {open:draw};
}
