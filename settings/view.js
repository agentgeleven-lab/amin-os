import {getAppearance,PALETTES,APP_NAMES,defaults} from './appearance.js';
const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
export function mount(target){
 const service=getAppearance();target.classList.add('amin-ai','amin-settings');let page='global';
 function draw(){
  const draft=service.snapshot();target.replaceChildren(el('h2','设置'),el('p','统一窗口与应用外观。应用默认跟随全局，也可以设置自己的风格。'));
  const nav=el('nav'),body=el('section'),notice=el('p');notice.setAttribute('role','status');target.append(nav,body,notice);
  const button=(parent,label,fn)=>{const e=el('button',label);e.type='button';e.onclick=()=>{try{fn();}catch(error){notice.textContent=error.message;}};parent.append(e);return e;};
  for(const [id,name]of [['global','整体外观'],['apps','单个应用'],['floor','楼层窗口']]){const b=button(nav,name,()=>{page=id;draw();});b.setAttribute('aria-pressed',String(page===id));}
  function select(parent,label,items,value,onchange){const wrap=el('label',label),control=el('select');for(const [id,name]of items){const o=el('option',name);o.value=id;control.append(o);}control.setAttribute('aria-label',label);control.value=value;control.onchange=()=>onchange(control.value);wrap.append(control);parent.append(wrap);return control;}
  function numeric(parent,label,value,min,max,onchange){const wrap=el('label',`${label}（${min}–${max}）`),control=el('input');control.type='number';control.min=min;control.max=max;control.value=value;control.oninput=()=>onchange(Number(control.value));wrap.append(control);parent.append(wrap);}
  function fields(parent,value){
   select(parent,'主题',Object.entries(PALETTES).map(([id,p])=>[id,p.name]),value.theme,v=>value.theme=v);
   numeric(parent,'字号',value.fontSize,11,20,v=>value.fontSize=v);numeric(parent,'圆角',value.radius,0,24,v=>value.radius=v);
   select(parent,'内容间距',[['comfortable','舒适'],['compact','紧凑']],value.density,v=>value.density=v);
   numeric(parent,'背景不透明度 %',value.opacity,70,100,v=>value.opacity=v);numeric(parent,'背景模糊',value.blur,0,24,v=>value.blur=v);
  }
  if(page==='global'){
   fields(body,draft.global);body.append(el('h3','侧栏尺寸'),el('p','屏幕空间不足时自动缩小；位置保持在可见范围内。'));
   numeric(body,'桌面侧栏宽度',draft.window.width,340,800,v=>draft.window.width=v);numeric(body,'侧栏最大高度',draft.window.height,400,1000,v=>draft.window.height=v);
  }else if(page==='apps'){
   for(const [id,name]of Object.entries(APP_NAMES)){
    const card=el('details');card.className='amin-appearance-card';card.append(el('summary',name));const content=el('div');card.append(content);body.append(card);
    const choice=select(content,'外观来源',[['inherit','跟随全局'],['own','使用单独外观']],draft.apps[id]?'own':'inherit',value=>{if(value==='own')draft.apps[id]={...draft.global};else delete draft.apps[id];render();});
    const editor=el('div');content.append(editor);const render=()=>{editor.replaceChildren();if(draft.apps[id])fields(editor,draft.apps[id]);else editor.append(el('p','全局外观变化会自动应用到这里。'));};render();
   }
  }else{
   body.append(el('p','消息楼层中的状态记录随消息宽度排版：桌面可以并排展示卡片，窄屏自动改为单列。超过高度时在窗口内滚动。'));
   numeric(body,'桌面最大宽度',draft.floor.width,320,1400,v=>draft.floor.width=v);numeric(body,'桌面最大高度（占屏幕 %）',draft.floor.desktopHeight,30,90,v=>draft.floor.desktopHeight=v);numeric(body,'手机最大高度（占屏幕 %）',draft.floor.mobileHeight,30,85,v=>draft.floor.mobileHeight=v);
   body.append(el('p','楼层窗口跟随“世界状态”的外观；未设置单独外观时跟随全局。'));
  }
  button(body,'保存并应用',()=>{service.save(draft);notice.textContent='已应用。打开的窗口同步更新，编辑内容会保留。';}).className='amin-primary';
  button(body,'恢复本页默认',()=>{const next=service.snapshot(),d=defaults();if(page==='global'){next.global=d.global;next.window=d.window;}else if(page==='apps')next.apps={};else next.floor=d.floor;service.save(next);draw();});
 }
 draw();return {open:draw};
}
