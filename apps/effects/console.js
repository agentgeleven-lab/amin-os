import {activeEffects,change} from './model.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function appearance(skill){return {icon:'✦',size:'medium',tone:'accent',group:'能力',scope:skill.name,condition:'直到主动解除；其他条件按能力规则确认。',command:'',...skill.ui};}
export function reorder(skills,id,target,after=false){
 const next=structuredClone(skills),from=next.find(s=>s.id===id),to=next.find(s=>s.id===target);
 if(!from||!to||id===target)return next;
 from.ui={...appearance(from),group:appearance(to).group};const rest=next.filter(s=>s.id!==id),i=rest.findIndex(s=>s.id===target);rest.splice(i+(after?1:0),0,from);return rest;
}
export function renderConsole({body,api,state,say,render,manage,adjust,end}){
 const store=api.read(),ctx=api.context(),token=api.capture();
 const effects=activeEffects(store,ctx.chat),skills=store.skills.filter(s=>s.ui?.hidden!==true);
 const button=(parent,text,action,cls='')=>{const b=el('button',text,cls);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){say(e.message);}finally{b.disabled=false;}};parent.append(b);return b;};
 const label=(parent,text,value)=>{const l=el('label',text),input=el('input');input.value=value;input.setAttribute('aria-label',text);l.append(input);parent.append(l);return input;};
 const hero=el('section',null,'amin-card amin-ability-target');hero.append(el('small','当前连接'),el('h3',state.target||'选择一个目标'));
 const fields=el('div',null,'amin-target-fields');hero.append(fields);
 const target=label(fields,'目标角色',state.target);target.placeholder='选择角色，或输入剧情中的任何目标';target.setAttribute('list','amin-ability-targets');
 const names=new Set([...(ctx.characters??[]).filter((c,i)=>ctx.groupId?(ctx.groups??[]).find(g=>String(g.id)===String(ctx.groupId))?.members?.includes(c.avatar):i===ctx.characterId).map(c=>c.name),...effects.map(e=>e.target)].filter(Boolean));
 const list=el('datalist');list.id='amin-ability-targets';for(const n of names){const o=el('option');o.value=n;list.append(o);}hero.append(list);
 target.oninput=()=>{state.target=target.value;hero.querySelector('h3').textContent=state.target||'选择一个目标';refreshEffects();};
 const holder=label(fields,'使用者',state.holder||ctx.name1||'');holder.oninput=()=>state.holder=holder.value;
 body.append(hero);
 const tools=el('div',null,'amin-toolbar');body.append(tools);
 const edit=button(tools,state.editing?'完成布局':'编辑布局',()=>{state.editing=!state.editing;render();});edit.setAttribute('aria-pressed',String(!!state.editing));
 button(tools,'添加 / 管理能力',manage);
 if(!skills.length)body.append(el('p','先添加一个能力按钮，再选择目标发动。可手动创建，也可从世界书导入。'));
 if(state.editing)body.append(el('p','拖动按钮调整位置；跨组拖动会移入目标分组。也可用前移、后移按钮。大小、图标、颜色在能力管理中设置。'));
 const groups=[...new Set(skills.map(s=>appearance(s).group||'能力'))];
 async function move(id,to,after){await api.saveLibrary(token,s=>({...s,skills:reorder(s.skills,id,to,after)}));render();say('共享能力布局已保存，所有角色和聊天通用');}
 for(const group of groups){
  body.append(el('h3',group));const grid=el('div',null,'amin-ability-grid');grid.classList.toggle('is-editing',!!state.editing);body.append(grid);
  for(const skill of skills.filter(s=>(appearance(s).group||'能力')===group)){
   const ui=appearance(skill),tile=el('div',null,'amin-ability-tile');tile.dataset.ability=skill.id;tile.dataset.size=ui.size;tile.dataset.tone=ui.tone;
   const b=button(tile,'',()=>{if(state.editing)return;if(!state.target.trim())throw Error('请先填写目标角色');launch(skill);},'amin-ability-launch');b.setAttribute('aria-label','发动 '+skill.name);b.append(el('span',ui.icon,'amin-ability-icon'),el('strong',skill.name));
   const count=effects.filter(e=>e.skill.id===skill.id&&e.target===state.target&&!e.paused).length;b.append(el('small',count?'生效中 · '+count:'点击发动'));
   if(state.editing){const controls=el('div',null,'amin-toolbar');tile.append(controls);const i=skills.indexOf(skill);button(controls,'前移',()=>move(skill.id,skills[i-1].id)).disabled=i===0;button(controls,'后移',()=>move(skill.id,skills[i+1].id,true)).disabled=i===skills.length-1;}
   grid.append(tile);
  }
 }
 // Pointer drag works on touch in edit mode; normal mode remains scrollable.
 let drag=null,suppressed=false;
 body.onpointerdown=e=>{if(!state.editing||e.button!==0||!e.isPrimary)return;const tile=e.target.closest('[data-ability]');if(!tile||e.target.closest('.amin-toolbar'))return;drag={id:tile.dataset.ability,pointer:e.pointerId,x:e.clientX,y:e.clientY};tile.classList.add('is-dragging');body.setPointerCapture(e.pointerId);};
 body.onpointermove=e=>{if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>8){suppressed=true;e.preventDefault();}};
 const cleanup=()=>{body.querySelectorAll('.is-dragging').forEach(e=>e.classList.remove('is-dragging'));drag=null;};
 body.onpointercancel=cleanup;
 body.onpointerup=async e=>{if(!drag)return;const id=drag.id;const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-ability]');cleanup();if(suppressed&&hit&&body.contains(hit))try{await move(id,hit.dataset.ability,e.clientY>hit.getBoundingClientRect().y+hit.getBoundingClientRect().height/2);}catch(err){say(err.message);}suppressed=false;};
 const effectList=el('div');body.append(effectList);
 function refreshEffects(){effectList.replaceChildren();for(const tile of body.querySelectorAll('[data-ability]')){const count=effects.filter(e=>e.skill.id===tile.dataset.ability&&e.target===state.target&&!e.paused).length;tile.querySelector('.amin-ability-launch small').textContent=count?'生效中 · '+count:'点击发动';}
 const current=effects.filter(e=>!state.target||e.target===state.target);effectList.append(el('h3','当前效果 · '+current.length));
 if(!current.length)effectList.append(el('p','该目标还没有持续效果。'));
 for(const e of current){const c=el('section',null,'amin-card');c.append(el('h3',e.skill.name+(e.paused?' · 已暂停':'')),el('p',e.target+' · '+e.scope),el('p',e.command||'未指定指令'));const actions=el('div',null,'amin-toolbar');c.append(actions);button(actions,'调整指令',()=>adjust(e));button(actions,e.paused?'恢复':'暂停',async()=>{await api.save(token,s=>change(s,api.context().chat,'pause',{id:e.id,paused:!e.paused}));render();});button(actions,'解除',()=>end(e));effectList.append(c);}
 }
 refreshEffects();
 function launch(skill){
  const capture=api.capture(),ui=appearance(skill),targetName=state.target.trim(),user=state.holder||ctx.name1||'';
  body.replaceChildren();body.closest('.amin-app-pane')?.scrollTo(0,0);const c=el('section',null,'amin-card');body.append(c);c.append(el('small',targetName+' ← '+user),el('h3',ui.icon+' '+skill.name));
  const row=el('label','具体指令'),input=el('textarea');input.rows=5;input.value=ui.command;input.setAttribute('aria-label','具体指令');input.placeholder='这次希望能力产生什么效果？';row.append(input);c.append(row);
  const details=el('details');details.append(el('summary','作用范围与持续条件'));c.append(details);const scope=label(details,'作用层面',ui.scope),condition=label(details,'持续或解除条件',ui.condition);
  c.append(el('p','发动后会保存为持续效果，后续生成剧情时附加提醒。'));
  button(c,'确认发动',async()=>{await api.save(capture,s=>change(s,api.context().chat,'create',{skillId:skill.id,holder:user,target:targetName,scope:scope.value,command:input.value,condition:condition.value}));render();say('已发动：'+skill.name+' → '+targetName);},'amin-primary');button(c,'返回能力面板',render);
 }
}
