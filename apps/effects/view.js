import {bookCatalog,readBook} from './books.js';
import {hostWorldSettings} from '../reply/world-context.js';
import {activeEffects,anchor,belongs,change,compile} from './model.js';
import {createEffects} from './service.js';
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function mount(target){
 const api=createEffects(()=>globalThis.SillyTavern?.getContext?.());
 const page=node('div',null,'amin-page amin-effects'),context=node('div','关联世界书，按当前聊天维持技能效果。','amin-context');
 const tabs=node('div',null,'amin-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','持续效果页面');
 const status=node('div',null,'amin-notice');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const body=node('section');body.id='amin-effects-content';body.setAttribute('role','tabpanel');
 page.append(context,tabs,status,body);target.append(page);let selected='技能库',entries=[],books=[],chosenBook='',loadedBook='',loadEpoch=0;
 const say=text=>{status.textContent=text;};
 const button=(parent,label,fn,primary=false)=>{const b=node('button',label,primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{b.disabled=false;}};parent.append(b);return b;};
 const tabButtons=['技能库','生效中','变更记录','提示预览'].map((name,i)=>{
  const b=button(tabs,name,()=>{selected=name;render();});b.id='amin-effects-tab-'+i;b.setAttribute('role','tab');b.setAttribute('aria-controls',body.id);return b;
 });
 tabs.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();let i=tabButtons.findIndex(b=>b.textContent===selected);i=e.key==='Home'?0:e.key==='End'?3:(i+(e.key==='ArrowRight'?1:3))%4;selected=tabButtons[i].textContent;render();tabButtons[i].focus();};
 function field(parent,label,value='',multiline=false){const row=node('label',label),input=node(multiline?'textarea':'input');input.value=value;input.setAttribute('aria-label',label);if(multiline)input.rows=4;row.append(input);parent.append(row);return input;}
 function select(parent,label,options){const row=node('label',label),input=node('select');input.setAttribute('aria-label',label);for(const [value,text]of options){const o=node('option',text);o.value=value;input.append(o);}row.append(input);parent.append(row);return input;}
 function card(title){const c=node('section',null,'amin-card');c.append(node('h3',title));body.append(c);return c;}
 function finish(text){render();say(text);}
 async function load(){const token=api.capture(),epoch=++loadEpoch;const c=api.check(token);say('读取当前启用的世界书列表…');const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;books=bookCatalog(c,config);chosenBook='';loadedBook='';entries=[];render();say(books.length?'请选择一本世界书，再读取条目。':'当前没有全局启用或绑定的世界书，请先在酒馆中启用。');}
 async function loadSelected(){if(!chosenBook)throw Error('请先选择世界书');const token=api.capture(),epoch=++loadEpoch;const c=api.check(token),name=chosenBook;const config=await hostWorldSettings(c);api.check(token);if(epoch!==loadEpoch)return;const book=bookCatalog(c,config).find(b=>b.name===name);if(!book)throw Error('这本世界书已停用或解绑，请刷新列表');say('读取「'+name+'」…');const result=await readBook(c,book);api.check(token);if(epoch!==loadEpoch)return;entries=result;loadedBook=name;render();say(`已读取「${name}」：${entries.length} 条有效条目`);}
 function importForm(entry,existing){const token=api.capture();body.replaceChildren();const c=card('关联技能');const name=field(c,'技能名称',existing?.name||entry.title||'未命名技能');const original=node('details');original.append(node('summary','查看世界书原文'),node('pre',entry.content));c.append(original);
  const reminder=field(c,'持续提醒规则（可精简，不修改世界书）',existing?.reminder??entry.content,true);c.append(node('p','生效时保存规则快照；世界书以后修改，不会悄悄改变已发动的效果。'));
  button(c,'保存关联',async()=>{if(!name.value.trim()||!reminder.value.trim())throw Error('技能名称和提醒规则不能为空');await api.save(token,s=>{if(!existing&&s.skills.some(x=>x.book===entry.book&&x.entryId===entry.id))throw Error('此条目已经关联');if(existing){const skill=s.skills.find(x=>x.id===existing.id);if(!skill)throw Error('技能已不存在');skill.name=name.value.trim();skill.reminder=reminder.value.trim();return s;}s.skills.push({id:crypto.randomUUID(),book:entry.book,entryId:entry.id,name:name.value.trim(),original:entry.content,reminder:reminder.value.trim()});return s;});finish('已关联技能，原世界书未修改');},true);button(c,'返回',render);
 }
 function effectForm(effect){const token=api.capture(),store=api.read();body.replaceChildren();const c=card(effect?'调整指令 / 转让':'建立生效记录');let skill;
  if(!effect)skill=select(c,'技能',store.skills.map(s=>[s.id,s.name]));
  const holder=field(c,'持有者',effect?.holder??''),targetField=field(c,'目标',effect?.target??''),scope=field(c,'作用层面',effect?.scope??'');if(effect){targetField.disabled=true;scope.disabled=true;}
  const command=field(c,'当前指令',effect?.command??'',true),condition=field(c,'持续或解除条件',effect?.condition??'直到主动解除或转让；其他条件按技能规则人工确认。',true);
  button(c,'确认保存',async()=>{await api.save(token,s=>change(s,api.context().chat,effect?'update':'create',{id:effect?.id,skillId:skill?.value,holder:holder.value,target:targetField.value,scope:scope.value,command:command.value,condition:condition.value}));selected='生效中';finish('生效记录已保存');},true);button(c,'取消',render);
 }
 function endForm(effect){const token=api.capture();body.replaceChildren();const c=card('解除：'+effect.target+' / '+effect.scope),reason=field(c,'解除依据','',true);button(c,'确认解除',async()=>{await api.save(token,s=>change(s,api.context().chat,'end',{id:effect.id,reason:reason.value}));finish('已解除此项效果');},true);button(c,'取消',render);}
 function splitForm(effect){const token=api.capture();body.replaceChildren();const c=card('分割：'+effect.target+' / '+effect.scope);c.append(node('p','每行填写“作用层面 | 持有者”。保存后原关系结束，由子记录接替；请完整列出需要保留的范围。'));
  const parts=field(c,'分割与分配','',true);button(c,'确认分割',async()=>{const rows=parts.value.split('\n').filter(x=>x.trim()).map(x=>x.split('|').map(v=>v.trim()));if(rows.length<2||rows.some(x=>x.length!==2||!x[0]||!x[1]))throw Error('至少填写两行，格式为：右手 | 持有者');await api.save(token,s=>{let next=change(s,api.context().chat,'end',{id:effect.id,reason:'分割为：'+rows.map(x=>x[0]).join('、')});for(const [scope,holder]of rows){next=change(next,api.context().chat,'create',{skillId:effect.skill.id,target:effect.target,holder,scope,command:effect.command,condition:effect.condition});next.events.at(-1).effect.parentId=effect.id;next.events.at(-1).effect.skill=structuredClone(effect.skill);}return next;});finish('已分割，子记录保留原规则快照');},true);button(c,'取消',render);
 }
 function render(){
  for(const b of tabButtons){const on=b.textContent===selected;b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;if(on)body.setAttribute('aria-labelledby',b.id);}
  body.replaceChildren();status.textContent=api.status();
  try{const store=api.read(),chat=api.context()?.chat??[];
   if(selected==='技能库'){
    button(body,'刷新世界书列表',load,true);
    if(books.length){const picker=select(body,'选择世界书',[['','请选择一本世界书'],...books.map(b=>[b.name,b.name+' · '+b.sources.join(' / ')])]);picker.value=chosenBook;picker.onchange=()=>{chosenBook=picker.value;entries=[];loadedBook='';loadEpoch++;render();};button(body,'读取所选世界书',loadSelected,true).disabled=!chosenBook;}
    if(loadedBook)body.append(node('p','当前查看：'+loadedBook+(entries.length?'':' · 没有启用的非空条目')));
    for(const s of store.skills){const c=card(s.name);c.append(node('p',s.book+' · 条目 '+s.entryId));const d=node('details');d.append(node('summary','查看保存的原文与提醒规则'),node('pre',s.original),node('pre',s.reminder));c.append(d);button(c,'编辑提醒',()=>importForm({book:s.book,id:s.entryId,title:s.name,content:s.original},s));}
    if(!store.skills.length)body.append(node('p','先刷新列表，选择一本全局启用或当前绑定的世界书，再选择技能条目保存。'));
    if(entries.length){const filter=field(body,'筛选世界书条目'),list=node('div');body.append(list);const draw=()=>{list.replaceChildren();for(const e of entries.filter(e=>(e.book+e.title+e.content).includes(filter.value))){button(list,(e.title||'条目 '+e.id)+' · '+e.book,()=>importForm(e));}};filter.oninput=draw;draw();}
   }else if(selected==='生效中'){
    button(body,'建立生效记录',()=>effectForm(),true).disabled=!store.skills.length;
    const effects=activeEffects(store,chat);if(!effects.length)body.append(node('p','当前分支没有生效记录。拥有技能不等于已经发动。'));
    for(const e of effects){const c=card(e.skill.name+' · '+e.target);c.append(node('p','持有者：'+e.holder+' ｜ 层面：'+e.scope),node('p','当前指令：'+(e.command||'未指定')),node('p','持续条件：'+e.condition));const toolbar=node('div',null,'amin-toolbar');c.append(toolbar);button(toolbar,'调整 / 转让',()=>effectForm(e));button(toolbar,'分割',()=>splitForm(e));button(toolbar,'解除',()=>endForm(e));}
   }else if(selected==='变更记录'){
    const now=anchor(chat);if(!store.events.length)body.append(node('p','尚无变更。'));
    for(const e of [...store.events].reverse()){const active=belongs(e,now),c=card(`${e.floor} 楼 · ${{create:'建立',update:'调整 / 转让',end:'解除'}[e.op]}`);c.append(node('p',active?'属于当前分支':'原分支记录 · 当前不生效'),node('p',e.at),node('pre',JSON.stringify(e.effect??e.patch??{原因:e.reason},null,2)));}
   }else{
    const token=api.capture();const toggle=node('label','生成时附加持续提醒'),check=node('input');check.type='checkbox';check.checked=store.enabled;toggle.append(check);body.append(toggle);
    const limit=field(body,'提醒字符上限（1000–200000）',String(store.limit));limit.type='number';limit.min=1000;limit.max=200000;
    button(body,'保存提醒设置',async()=>{const n=Number(limit.value);if(!Number.isInteger(n)||n<1000||n>200000)throw Error('字符上限需为 1000–200000 的整数');await api.save(token,s=>({...s,enabled:check.checked,limit:n}));finish('提醒设置已保存');});
    let prompt;try{prompt=compile(store,chat);}catch(e){prompt=e.message;}body.append(node('p','以下为当前分支下次生成将使用的提醒；超过上限会明确提示，不会截掉部分效果。'),node('pre',prompt||'无提醒'));
   }
  }catch(e){say(e.message);}
 }
 api.subscribe(()=>{status.textContent=api.status();});
 const ctx=api.context(),events=ctx.eventTypes??ctx.event_types??{};
 if(events.CHAT_CHANGED)ctx.eventSource?.on(events.CHAT_CHANGED,()=>{entries=[];books=[];chosenBook='';loadedBook='';loadEpoch++;render();});
 render();return {open(){render();}};
}
