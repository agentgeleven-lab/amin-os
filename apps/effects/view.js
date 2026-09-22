import {deleteAbility,restoreAbility,UNGROUPED,abilityGroup,groupNames,addGroup,renameGroup,removeGroup} from './library.js';
import {renderConsole,appearance} from './console.js';
import {getAI} from '../../ai/service.js';
import {draftRule} from './draft.js';
import {bookCatalog,readBook} from './books.js';
import {hostWorldSettings} from '../reply/world-context.js';
import {activeEffects,anchor,belongs,change,compile,splitEffect,directEffect,effectTarget} from './model.js';
import {getSharedService} from './service.js';
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function mount(target,options={}){
 const instanceId='amin-'+crypto.randomUUID();
 const api=options.api??getSharedService();
 const page=node('div',null,'amin-page amin-effects'),context=node('div','先选择分组和能力；可对指定对象使用，也可无目标直接发动。','amin-context');
 const tabs=node('div',null,'amin-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','持续效果页面');
 const status=node('div',null,'amin-notice');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const body=node('section');body.id=instanceId+'-body';body.setAttribute('role','tabpanel');
 page.append(context,tabs,status,body);target.append(page);const consoleState={target:'',holder:'',group:'',skillId:'',targetMode:null};const managementState={group:'',skillId:''};let formOpen=false,formDirty=false;let selected='能力面板',entries=[],books=[],chosenBook='',loadedBook='',loadEpoch=0,draftController=null;
 const openForm=()=>{formOpen=true;formDirty=false;};
 body.addEventListener('input',()=>{if(formOpen)formDirty=true;});body.addEventListener('change',()=>{if(formOpen)formDirty=true;});
 const navigate=fn=>{if(formOpen&&(formDirty||draftController)){say('有未保存的编辑，请先保存，或点击表单的取消／返回按钮放弃修改。');return;}fn();};
 const stopDraft=()=>{draftController?.abort();draftController=null;};
 const say=text=>{status.textContent=text;};
 const button=(parent,label,fn,primary=false)=>{const b=node('button',label,primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{b.disabled=false;}};parent.append(b);return b;};
 const tabButtons=['能力面板','能力管理','生效中','变更记录','提示预览'].map((name,i)=>{
  const b=button(tabs,name,()=>navigate(()=>{selected=name;render();}));b.id=instanceId+'-tab-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls',body.id);return b;
 });
 tabs.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();let i=tabButtons.findIndex(b=>b.textContent===selected);i=e.key==='Home'?0:e.key==='End'?4:(i+(e.key==='ArrowRight'?1:4))%5;navigate(()=>{selected=tabButtons[i].textContent;render();tabButtons[i].focus();});};
 function field(parent,label,value='',multiline=false){const row=node('label',label),input=node(multiline?'textarea':'input');input.value=value;input.setAttribute('aria-label',label);if(multiline)input.rows=4;row.append(input);parent.append(row);return input;}
 function select(parent,label,options){const row=node('label',label),input=node('select');input.setAttribute('aria-label',label);for(const [value,text]of options){const o=node('option',text);o.value=value;input.append(o);}row.append(input);parent.append(row);return input;}
 function card(title){const c=node('section',null,'amin-card');c.append(node('h3',title));body.append(c);return c;}
 function finish(text){render();say(text);}
 async function load(){const token=api.capture(),epoch=++loadEpoch;const c=api.check(token);say('读取当前启用的世界书列表…');const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;books=bookCatalog(c,config);chosenBook='';loadedBook='';entries=[];render();say(books.length?'请选择一本世界书，再读取条目。':'当前没有全局启用或绑定的世界书，请先在酒馆中启用。');}
 async function loadSelected(){if(!chosenBook)throw Error('请先选择世界书');const token=api.capture(),epoch=++loadEpoch;const c=api.check(token),name=chosenBook;const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;const book=bookCatalog(c,config).find(b=>b.name===name);if(!book)throw Error('这本世界书已停用或解绑，请刷新列表');say('读取「'+name+'」…');const result=await readBook(c,book);api.check(token);if(epoch!==loadEpoch)return;entries=result;loadedBook=name;render();say(`已读取「${name}」：${entries.length} 条有效条目`);}
 function importForm(entry,existing){openForm();stopDraft();const token=api.capture();body.replaceChildren();const c=card(existing?'编辑能力':'添加能力');const name=field(c,'技能名称',existing?.name||entry.title||'未命名技能');let source;if(entry.custom){source=field(c,'能力原文 / 设定',entry.content,true);}else{const original=node('details');original.append(node('summary','查看世界书原文'),node('pre',entry.content));c.append(original);}const sourceText=()=>source?.value??entry.content;
  const reminder=field(c,'持续提醒规则（可精简，不修改世界书）',existing?.reminder??entry.content,true);c.append(node('p','生效时保存规则快照；世界书以后修改，不会悄悄改变已发动的效果。'));
  const ui=appearance(existing??{name:name.value});const buttonOptions=node('details');buttonOptions.open=true;buttonOptions.append(node('summary','能力分组与默认发动设置'));c.append(buttonOptions);
  const icon=field(buttonOptions,'按钮图标（文字或符号）',ui.icon);icon.maxLength=12;
  const size=select(buttonOptions,'按钮大小',[['small','小'],['medium','中'],['wide','宽']]);size.value=ui.size;
  const tone=select(buttonOptions,'按钮颜色',[['accent','主题强调'],['soft','柔和'],['plain','简洁']]);tone.value=ui.tone;
  const availableGroups=groupNames(api.read());
   const group=select(buttonOptions,'所属分组',availableGroups.map(n=>[n,n]));group.value=existing?abilityGroup(existing):(availableGroups.includes(consoleState.group)?consoleState.group:UNGROUPED);
   const newGroup=field(buttonOptions,'新分组名称（可选）');newGroup.maxLength=40;
   const defaultMode=select(buttonOptions,'默认发动方式',[['targeted','对指定对象使用'],['direct','直接发动（无指定对象）']]);defaultMode.value=ui.targetMode;
   const scopeDefault=field(buttonOptions,'默认作用层面',entry.custom&&!existing?'':ui.scope),commandDefault=field(buttonOptions,'默认指令',ui.command,true),conditionDefault=field(buttonOptions,'默认持续条件',ui.condition,true);
  const visibleLabel=node('label','在能力面板显示');const visible=node('input');visible.type='checkbox';visible.checked=!ui.hidden;visibleLabel.append(visible);buttonOptions.append(visibleLabel);
  const buttonConfig=()=>({...existing?.ui,icon:icon.value.trim()||'✦',size:size.value,tone:tone.value,group:newGroup.value.trim()||group.value,targetMode:defaultMode.value,scope:scopeDefault.value.trim()||name.value.trim(),command:commandDefault.value,condition:conditionDefault.value.trim()||'直到主动解除',hidden:!visible.checked});
  const instruction=field(c,'给 AI 的补充要求（可选）','',true);instruction.placeholder='例如：精简为关键规则，完整保留解除条件。';
  const actions=node('div',null,'amin-toolbar');c.append(actions);
  const draftBox=node('section',null,'amin-card');draftBox.hidden=true;const candidate=field(draftBox,'AI 草稿（可修改后采用）','',true);c.append(draftBox);
  button(draftBox,'采用草稿到规则框',()=>{reminder.value=candidate.value;formDirty=true;say('已放入规则框，点击“保存能力”才会保存。');});
  button(actions,'AI 编写提醒',async()=>{
   const controller=new AbortController();draftController=controller;cancel.hidden=false;draftBox.hidden=true;say('AI 正在读取所选技能并起草规则…');
   const check=()=>{api.check(token);if(!c.isConnected)throw Error('规则编辑页已关闭');};
   try{const result=await draftRule({ai:getAI(),ctx:api.check(token),entry:{...entry,content:sourceText()},name:name.value,current:reminder.value,instruction:instruction.value,signal:controller.signal,check});candidate.value=result;draftBox.hidden=false;say('草稿已生成，请检查后采用；原规则尚未修改。');}
   catch(e){if(c.isConnected)say(controller.signal.aborted?'已取消，原规则未修改':e.message);}
   finally{cancel.hidden=true;if(draftController===controller)draftController=null;}
  },true);
  const cancel=button(actions,'取消生成',()=>{draftController?.abort();});cancel.hidden=true;
  c.append(node('p','使用 Amin os 的共享 API 和预设。AI 草稿不会自动保存，也不会改动已生效的规则快照。'));
  button(c,'保存能力',async()=>{if(!name.value.trim()||!sourceText().trim())throw Error('能力名称和原文不能为空');if(!reminder.value.trim())reminder.value=sourceText();await api.saveLibrary(token,s=>{if(newGroup.value.trim())s=addGroup(s,newGroup.value);if(!groupNames(s).includes(buttonConfig().group))throw Error('分组已不存在，请重新打开编辑器');if(!existing&&s.skills.some(x=>x.book===entry.book&&x.entryId===entry.id))throw Error('此条目已经关联');if(existing){const skill=s.skills.find(x=>x.id===existing.id);if(!skill)throw Error('技能已不存在');skill.name=name.value.trim();skill.reminder=reminder.value.trim();skill.ui=buttonConfig();if(entry.custom)skill.original=sourceText();return s;}s.skills.push({id:crypto.randomUUID(),book:entry.book,entryId:entry.id,name:name.value.trim(),original:sourceText(),custom:!!entry.custom,ui:buttonConfig(),reminder:reminder.value.trim()});return s;});finish('已保存到共享能力库，可在任意角色和聊天中发动');},true);button(c,'返回',render);
 }
 function deleteForm(skill){openForm();const token=api.capture();stopDraft();body.replaceChildren();const c=card('删除能力：'+skill.name);
  c.append(node('p','将从共享能力库和所有角色、聊天的能力按钮中移除。已发动效果继续保留，可在“生效中”单独暂停或解除。原世界书不受影响。'));
  c.append(node('p','删除后可在能力管理下方的“已删除能力”中恢复。'));
  button(c,'确认删除能力',async()=>{await api.saveLibrary(token,s=>deleteAbility(s,skill.id));finish('已删除能力；可在“已删除能力”中恢复，已发动效果保留');});button(c,'取消',render);
 }
 function effectForm(effect){
  openForm();const token=api.capture(),store=api.read();body.replaceChildren();const c=card(effect?'调整指令 / 转让':'建立生效记录');let skill,group;
  if(!effect){group=select(c,'记录能力分组',[['','全部分组'],...groupNames(store).map(n=>[n,n])]);skill=select(c,'技能',[['','请选择能力'],...store.skills.map(s=>[s.id,s.name])]);}
  const mode=select(c,'发动方式',[['targeted','对指定对象使用'],['direct','直接发动（无指定对象）']]);mode.value=directEffect(effect)?'direct':'targeted';mode.disabled=!!effect;
  const holder=field(c,'持有者',effect?.holder??api.context()?.name1??''),targetField=field(c,'目标',effect?.target??''),scope=field(c,'作用层面',effect?.scope??'');if(effect){targetField.disabled=true;scope.disabled=true;}
  const reflect=()=>{targetField.parentElement.hidden=mode.value==='direct';targetField.required=mode.value!=='direct';};mode.onchange=reflect;reflect();
  if(skill){group.onchange=()=>{skill.replaceChildren();for(const [id,text]of [['','请选择能力'],...store.skills.filter(s=>!group.value||abilityGroup(s)===group.value).map(s=>[s.id,s.name])]){const o=node('option',text);o.value=id;skill.append(o);}skill.value='';};skill.onchange=()=>{mode.value=store.skills.find(s=>s.id===skill.value)?.ui?.targetMode??'targeted';reflect();};}
  const command=field(c,'当前指令',effect?.command??'',true),condition=field(c,'持续或解除条件',effect?.condition??'直到主动解除或转让；其他条件按技能规则人工确认。',true);
  button(c,'确认保存',async()=>{await api.save(token,s=>change(s,api.context().chat,effect?'update':'create',{id:effect?.id,skillId:skill?.value,holder:holder.value,targetMode:mode.value,target:mode.value==='direct'?'':targetField.value,scope:scope.value,command:command.value,condition:condition.value}));finish('生效记录已保存');},true);button(c,'取消',render);
 }
 function groupManager(){
  stopDraft();formOpen=false;formDirty=false;body.replaceChildren();const store=api.read();card('能力分组').append(node('p','分组跨角色和聊天共享。删除分组只将能力移回“未分组”，不删除能力或历史效果。'));
  button(body,'新建分组',()=>groupEditor(),true);button(body,'返回',render);
  for(const name of groupNames(store)){const c=card(name+' · '+store.skills.filter(s=>abilityGroup(s)===name).length+' 项');if(name===UNGROUPED)continue;button(c,'重命名分组',()=>groupEditor(name));button(c,'删除分组',()=>deleteGroupForm(name));}
 }
 function groupEditor(from){
  openForm();const token=api.capture();body.replaceChildren();const c=card(from?'重命名分组：'+from:'新建分组'),name=field(c,'分组名称',from??'');name.maxLength=40;
  button(c,'保存分组',async()=>{await api.saveLibrary(token,s=>from?renameGroup(s,from,name.value):addGroup(s,name.value));if(consoleState.group===from)consoleState.group=name.value.trim();if(managementState.group===from)managementState.group=name.value.trim();finish('分组已保存；已有能力和规则快照均保留');},true);button(c,'取消',render);
 }
 function deleteGroupForm(name){
  openForm();const token=api.capture();body.replaceChildren();const c=card('删除分组：'+name);c.append(node('p','确认后该组能力移到“未分组”。不会删除能力，也不会改写已经发动的效果。'));
  button(c,'确认删除分组',async()=>{await api.saveLibrary(token,s=>removeGroup(s,name));if(consoleState.group===name){consoleState.group=UNGROUPED;consoleState.skillId='';}if(managementState.group===name){managementState.group=UNGROUPED;managementState.skillId='';}finish('已删除分组，能力已移到“未分组”');});button(c,'取消',render);
 }
 function deleteEffect(effect){const token=api.capture();return api.save(token,s=>change(s,api.context().chat,'delete',{id:effect.id})).then(()=>finish('已删除此生效记录，不再发送该效果；能力库保留'));}
 function endForm(effect){openForm();const token=api.capture();body.replaceChildren();const c=card('解除：'+effectTarget(effect)+' / '+effect.scope),reason=field(c,'解除依据','',true);button(c,'确认解除',async()=>{await api.save(token,s=>change(s,api.context().chat,'end',{id:effect.id,reason:reason.value}));finish('已解除此项效果');},true);button(c,'取消',render);}
 function splitForm(effect){openForm();const token=api.capture();body.replaceChildren();const c=card('分割：'+effectTarget(effect)+' / '+effect.scope);c.append(node('p','每行填写“作用层面 | 持有者”。保存后原关系结束，由子记录接替；请完整列出需要保留的范围。'));
  const parts=field(c,'分割与分配','',true);button(c,'确认分割',async()=>{const rows=parts.value.split('\n').filter(x=>x.trim()).map(x=>x.split('|').map(v=>v.trim()));if(rows.length<2||rows.some(x=>x.length!==2||!x[0]||!x[1]))throw Error('至少填写两行，格式为：右手 | 持有者');await api.save(token,s=>splitEffect(s,api.context().chat,effect.id,rows.map(([scope,holder])=>({scope,holder}))));finish('已分割，子记录保留原规则快照');},true);button(c,'取消',render);
 }
 function render(){
  formOpen=false;formDirty=false;
  body.onpointerdown=body.onpointermove=body.onpointerup=body.onpointercancel=null;
  stopDraft();
  for(const b of tabButtons){const on=b.textContent===selected;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on)body.setAttribute('aria-labelledby',b.id);}
  body.replaceChildren();target.scrollTop=0;status.textContent=api.status();
  try{const store=api.read(),chat=api.context()?.chat??[];
   if(selected==='能力面板'){renderConsole({body,api,state:consoleState,say,render,manage:()=>{selected='能力管理';render();},groups:groupManager,editSkill:s=>importForm({book:s.book,id:s.entryId,title:s.name,content:s.original,custom:s.custom},s),onFormOpen:openForm,adjust:effectForm,end:endForm,remove:deleteEffect});
   }else if(selected==='能力管理'){
    body.append(node('p','共享能力库 · 所有角色和聊天通用。能力原文、规则和按钮布局独立保存，原世界书停用或删除也可使用。生效记录仅属于当前聊天。'));
    body.append(node('p','打开旧聊天的能力面板时，会自动收纳其中的旧能力；不同版本保留为独立能力。'));
    button(body,'手动添加能力',()=>importForm({book:'自定义能力',id:crypto.randomUUID(),title:'',content:'',custom:true}),true);
    button(body,'管理分组',groupManager);
    button(body,'刷新世界书列表',load,true);
    if(books.length){const picker=select(body,'选择世界书',[['','请选择一本世界书'],...books.map(b=>[b.name,b.name+' · '+b.sources.join(' / ')])]);picker.value=chosenBook;picker.onchange=()=>{chosenBook=picker.value;entries=[];loadedBook='';loadEpoch++;render();};button(body,'读取所选世界书',loadSelected,true).disabled=!chosenBook;}
    if(loadedBook)body.append(node('p','当前查看：'+loadedBook+(entries.length?'':' · 没有启用的非空条目')));
    const allGroups=groupNames(store);if(managementState.group&&!allGroups.includes(managementState.group)){managementState.group='';managementState.skillId='';}
    const groupFilter=select(body,'管理分组筛选',[['','全部分组'],...allGroups.map(n=>[n,n])]);groupFilter.value=managementState.group;
    const matching=store.skills.filter(s=>!managementState.group||abilityGroup(s)===managementState.group);if(!matching.some(s=>s.id===managementState.skillId))managementState.skillId='';
    const abilitySelect=select(body,'管理能力',[['','请选择要管理的能力'],...matching.map(s=>[s.id,s.name+(s.ui?.hidden?'（已隐藏）':'')])]);abilitySelect.value=managementState.skillId;
    groupFilter.onchange=()=>{managementState.group=groupFilter.value;managementState.skillId='';render();};abilitySelect.onchange=()=>{managementState.skillId=abilitySelect.value;render();};
    for(const s of matching.filter(s=>s.id===managementState.skillId)){const c=card(s.name);c.append(node('p',s.book+' · 条目 '+s.entryId));const d=node('details');d.append(node('summary','查看保存的原文与提醒规则'),node('pre',s.original),node('pre',s.reminder));c.append(d);button(c,'编辑能力',()=>importForm({book:s.book,id:s.entryId,title:s.name,content:s.original,custom:s.custom},s));button(c,'删除能力',()=>deleteForm(s));}
    if(store.trash?.length){const deleted=node('details');deleted.append(node('summary','已删除能力 · '+store.trash.length));body.append(deleted);for(const item of store.trash){const row=node('section',null,'amin-card');row.append(node('h3',item.skill.name));button(row,'恢复能力',async()=>{const token=api.capture();await api.saveLibrary(token,s=>restoreAbility(s,item.skill.id));finish('能力已恢复到共享能力库');});deleted.append(row);}}
    if(!store.skills.length)body.append(node('p','先刷新列表，选择一本全局启用或当前绑定的世界书，再选择技能条目保存。'));
    if(entries.length){const filter=field(body,'筛选世界书条目'),list=node('div');body.append(list);const draw=()=>{list.replaceChildren();for(const e of entries.filter(e=>(e.book+e.title+e.content).includes(filter.value))){button(list,(e.title||'条目 '+e.id)+' · '+e.book,()=>importForm(e));}};filter.oninput=draw;draw();}
   }else if(selected==='生效中'){
    button(body,'建立生效记录',()=>effectForm(),true).disabled=!store.skills.length;
    const effects=activeEffects(store,chat);if(!effects.length)body.append(node('p','当前分支没有生效记录。拥有技能不等于已经发动。'));
    for(const e of effects){const c=card(e.skill.name+' · '+effectTarget(e));c.append(node('p','持有者：'+e.holder+' ｜ 层面：'+e.scope),node('p','当前指令：'+(e.command||'未指定')),node('p','持续条件：'+e.condition));const toolbar=node('div',null,'amin-toolbar');c.append(toolbar);button(toolbar,'调整 / 转让',()=>effectForm(e));button(toolbar,'分割',()=>splitForm(e));button(toolbar,'解除',()=>endForm(e));button(toolbar,'删除生效记录',()=>deleteEffect(e));}
   }else if(selected==='变更记录'){
    const now=anchor(chat);if(!store.events.length)body.append(node('p','尚无变更。'));
    for(const e of [...store.events].reverse()){const active=belongs(e,now),c=card(`${e.floor} 楼 · ${{create:'建立',update:'调整 / 转让',end:'解除',delete:'删除生效记录',pause:e.paused?'暂停':'恢复'}[e.op]}`);c.append(node('p',active?'属于当前分支':'原分支记录 · 当前不生效'),node('p',e.at),node('pre',JSON.stringify(e.effect??e.patch??{原因:e.reason},null,2)));}
   }else{
    const token=api.capture();const toggle=node('label','生成时附加持续提醒'),check=node('input');check.type='checkbox';check.checked=store.enabled;toggle.append(check);body.append(toggle);
    const limit=field(body,'提醒字符上限（1000–200000）',String(store.limit));limit.type='number';limit.min=1000;limit.max=200000;
    button(body,'保存提醒设置',async()=>{const n=Number(limit.value);if(!Number.isInteger(n)||n<1000||n>200000)throw Error('字符上限需为 1000–200000 的整数');await api.save(token,s=>({...s,enabled:check.checked,limit:n}));finish('提醒设置已保存');});
    let prompt;try{prompt=compile(store,chat);}catch(e){prompt=e.message;}body.append(node('p','以下为当前分支下次生成将使用的提醒；超过上限会明确提示，不会截掉部分效果。'),node('pre',prompt||'无提醒'));
   }
  }catch(e){say(e.message);}
 }
 const unsubscribe=api.subscribe(event=>{if(!formOpen&&!event?.error)render();else status.textContent=api.status();});
 const ctx=api.context(),events=ctx.eventTypes??ctx.event_types??{};
 const chatChanged=()=>{entries=[];books=[];chosenBook='';loadedBook='';consoleState.target='';consoleState.holder='';consoleState.skillId='';consoleState.targetMode=null;managementState.skillId='';loadEpoch++;render();};if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,chatChanged);
 render();return {open(){if(!formOpen)render();},dispose(){stopDraft();loadEpoch++;unsubscribe();if(events.CHAT_CHANGED)ctx.eventSource?.removeListener?.(events.CHAT_CHANGED,chatChanged);page.remove();}};
}
