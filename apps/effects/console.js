import { uuid } from '../../uuid.js';
import {activeEffects,change,directEffect,effectTarget} from './model.js';
import {abilityGroup,groupNames} from './library.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function appearance(skill){return {icon:'✦',size:'medium',tone:'accent',group:'能力',scope:skill.name,condition:'直到主动解除；其他条件按能力规则确认。',command:'',targetMode:'targeted',...skill.ui};}
// Retained for compatibility with previously saved layouts; dropdown order uses this order.
export function reorder(skills,id,target,after=false){
 const next=structuredClone(skills),from=next.find(s=>s.id===id),to=next.find(s=>s.id===target);
 if(!from||!to||id===target)return next;
 from.ui={...appearance(from),group:appearance(to).group};const rest=next.filter(s=>s.id!==id),i=rest.findIndex(s=>s.id===target);rest.splice(i+(after?1:0),0,from);return rest;
}
export function renderConsole({body,api,state,say,render,manage,groups,editSkill,adjust,end,remove,onFormOpen}){
 const store=api.read(),ctx=api.context(),token=api.capture();
 const effects=activeEffects(store,ctx.chat),skills=store.skills.filter(s=>s.ui?.hidden!==true);
 const button=(parent,text,action,cls='')=>{const b=el('button',text,cls);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){say(e.message);}finally{b.disabled=false;}};parent.append(b);return b;};
 const label=(parent,text,value)=>{const l=el('label',text,'amin-field'),input=el('input');input.value=value;input.setAttribute('aria-label',text);l.append(input);parent.append(l);return input;};
 const select=(parent,text,choices,value)=>{const l=el('label',text,'amin-field'),input=el('select');input.setAttribute('aria-label',text);for(const [id,name]of choices){const o=el('option',name);o.value=id;input.append(o);}input.value=value;l.append(input);parent.append(l);return input;};
 const names=groupNames(store);
 if(state.group&&!names.includes(state.group)){state.group='';state.skillId='';}
 const choices=skills.filter(s=>!state.group||abilityGroup(s)===state.group);
 if(!choices.some(s=>s.id===state.skillId))state.skillId='';
 const tools=el('div',null,'amin-toolbar');body.append(tools);
 button(tools,'添加 / 管理能力',manage);if(groups)button(tools,'管理分组',groups);button(tools,'刷新能力列表',render);
 const chooser=el('section',null,'amin-card amin-stack amin-ability-chooser');body.append(chooser);chooser.append(el('h3','选择能力','amin-section-heading'));
 const filters=el('div',null,'amin-form-grid');chooser.append(filters);
 const group=select(filters,'能力分组',[['','全部分组'],...names.map(n=>[n,n])],state.group||'');
 const skillSelect=select(filters,'选择能力',[['','请选择能力'],...choices.map(s=>[s.id,s.name])],state.skillId||'');
 group.onchange=()=>{state.group=group.value;state.skillId='';state.targetMode=null;render();};
 skillSelect.onchange=()=>{state.skillId=skillSelect.value;state.targetMode=null;render();};
 if(!choices.length)chooser.append(el('p',skills.length?'这个分组没有可展示的能力。可切换分组，或在能力管理中添加／移动能力。':'还没有可展示的能力。可手动创建、从世界书导入，或检查能力的展示开关。','amin-empty'));
 const skill=choices.find(s=>s.id===state.skillId);
 let effectList;
 if(skill){
  const ui=appearance(skill),card=el('section',null,'amin-card amin-stack amin-selected-ability');card.dataset.ability=skill.id;
  card.append(el('h3',ui.icon+' '+skill.name,'amin-section-heading'),el('p','分组：'+abilityGroup(skill),'amin-meta'));
  const rule=el('details');rule.append(el('summary','查看能力说明与规则'),el('pre',skill.original),el('pre',skill.reminder));card.append(rule);
  const mode=select(card,'发动方式',[['targeted','对指定对象使用'],['direct','直接发动（无指定对象）']],state.targetMode??ui.targetMode);
  state.targetMode=mode.value;
  const fields=el('div',null,'amin-target-fields amin-form-grid');card.append(fields);
  const holder=label(fields,'使用者',state.holder||ctx.name1||'');holder.oninput=()=>state.holder=holder.value;
  const target=label(fields,'目标角色',state.target||'');target.placeholder='输入剧情中的使用对象';
  const list=el('datalist');list.id='amin-ability-targets-'+uuid();target.setAttribute('list',list.id);
  const targets=new Set([...(ctx.characters??[]).filter((c,i)=>ctx.groupId?(ctx.groups??[]).find(g=>String(g.id)===String(ctx.groupId))?.members?.includes(c.avatar):i===ctx.characterId).map(c=>c.name),...effects.map(e=>e.target)].filter(Boolean));
  for(const name of targets){const o=el('option');o.value=name;list.append(o);}card.append(list);
  const reflectMode=()=>{target.parentElement.hidden=state.targetMode==='direct';target.required=state.targetMode!=='direct';if(effectList)refreshEffects();};
  target.oninput=()=>{state.target=target.value;refreshEffects();};
  mode.onchange=()=>{state.targetMode=mode.value;reflectMode();};reflectMode();
  const actions=el('div',null,'amin-toolbar');card.append(actions);
  button(actions,'发动所选能力',()=>{api.check(token);if(state.targetMode!=='direct'&&!state.target?.trim())throw Error('请先填写目标角色，或选择直接发动');launch(skill,holder.value);},'amin-primary');
  if(editSkill)button(actions,'编辑所选能力',()=>{api.check(token);editSkill(skill);});
  body.append(card);
 }else if(choices.length)body.append(el('p','选择能力后可查看规则、指定目标并确认发动。','amin-empty'));
 effectList=el('div',null,'amin-stack');body.append(effectList);
 function refreshEffects(){
  effectList.replaceChildren();
  const current=effects.filter(e=>(!skill||e.skill.id===skill.id)&&(!skill||(state.targetMode==='direct'?directEffect(e):!directEffect(e)&&(!state.target||e.target===state.target))));
  effectList.append(el('h3','当前效果 · '+current.length,'amin-section-heading'));
  if(!current.length)effectList.append(el('p','当前选择还没有持续效果。','amin-empty'));
  for(const e of current){
   const c=el('section',null,'amin-card');c.append(el('h3',e.skill.name+(e.paused?' · 已暂停':'')),el('p',effectTarget(e)+' · '+e.scope),el('p','使用者：'+e.holder),el('p',e.command||'未指定指令'));
   const actions=el('div',null,'amin-toolbar');c.append(actions);
   button(actions,'调整指令',()=>adjust(e));button(actions,e.paused?'恢复':'暂停',async()=>{await api.save(token,s=>change(s,api.context().chat,'pause',{id:e.id,paused:!e.paused}));render();});
   button(actions,'解除',()=>end(e));button(actions,'删除生效记录',()=>remove(e),'amin-danger');effectList.append(c);
  }
 }
 refreshEffects();
 function launch(skill,user){
  const capture=api.capture(),ui=appearance(skill),targetMode=state.targetMode??ui.targetMode,targetName=targetMode==='direct'?'':state.target.trim();
  onFormOpen?.();body.replaceChildren();body.closest('.amin-app-pane')?.scrollTo(0,0);
  const c=el('section',null,'amin-card amin-stack');body.append(c);
  c.append(el('small',targetMode==='direct'?user+' · 直接发动（无指定对象）':targetName+' ← '+user,'amin-meta'),el('h3',ui.icon+' '+skill.name,'amin-section-heading'));
  const row=el('label','具体指令','amin-field'),input=el('textarea');input.rows=5;input.value=ui.command;input.setAttribute('aria-label','具体指令');input.placeholder='这次希望能力产生什么效果？';row.append(input);c.append(row);
  const details=el('details');details.append(el('summary','作用范围与持续条件'));c.append(details);const fields=el('div',null,'amin-form-grid');details.append(fields);const scope=label(fields,'作用层面',ui.scope),condition=label(fields,'持续或解除条件',ui.condition);
  c.append(el('p','确认后保存持续效果，后续生成剧情时附加提醒；不会自动发送聊天消息。'));
  const actions=el('div',null,'amin-toolbar');c.append(actions);button(actions,'确认发动',async()=>{await api.save(capture,s=>change(s,api.context().chat,'create',{skillId:skill.id,holder:user,targetMode,target:targetName,scope:scope.value,command:input.value,condition:condition.value}));render();say('已发动：'+skill.name+(targetMode==='direct'?' · 无指定对象':' → '+targetName));},'amin-primary');
  button(actions,'取消并返回能力面板',render);input.focus();
 }
}
