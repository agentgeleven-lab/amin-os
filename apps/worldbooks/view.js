import {getManager} from './runtime.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export async function mount(target,{manager}={}){
 const api=manager??await getManager(),page=el('div',null,'amin-page amin-worldbooks'),intro=el('div',null,'amin-context'),tabs=el('nav',null,'amin-tabs'),notice=el('p',null,'amin-notice'),body=el('section');
 notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');tabs.setAttribute('aria-label','世界书管理页面');page.append(intro,tabs,notice,body);target.append(page);
 let tab='角色组合',role=api.context()?.id,profile=api.profile(),names=[],query='',entryQuery='',book='',data=null,selected=new Set(),epoch=0,disposed=false,selecting=false;
 const expanded=new Set();
 const say=text=>notice.textContent=text;
 const button=(parent,text,fn,primary=false)=>{const b=el('button',text,primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{b.disabled=false;}};parent.append(b);return b;};
 const check=(parent,text,on,fn)=>{const label=el('label',null,'amin-wb-check'),input=el('input');input.type='checkbox';input.checked=on;input.onchange=()=>fn(input.checked);label.append(input,el('span',text));parent.append(label);return input;};
 const search=(parent,label,value,fn)=>{const row=el('label',label),input=el('input');input.type='search';input.value=value;input.oninput=()=>fn(input.value);row.append(input);parent.append(row);};
 const card=(parent,title)=>{const c=el('section',null,'amin-card');if(title)c.append(el('h3',title));parent.append(c);return c;};
 const fold=(parent,key,title)=>{const c=el('details',null,'amin-card amin-wb-fold');c.append(el('summary',title));c.open=expanded.has(key);c.ontoggle=()=>{if(!c.isConnected)return;if(c.open)expanded.add(key);else expanded.delete(key);};parent.append(c);return c;};
 const modes=[['keep','保持原样'],['on','启用'],['off','关闭']];
 function setRule(id,mode){profile.entries[book]??={};if(mode==='keep')delete profile.entries[book][id];else profile.entries[book][id]=mode;}
 async function loadBook(name){const run=++epoch,current=role;book='';data=null;render();say('正在读取世界书条目…');try{const result=await api.load(name);if(disposed||run!==epoch||current!==role||!profile.books.includes(name)||!api.globals().includes(name))return;book=name;data=result;selected=new Set();entryQuery='';render();}catch(error){if(!disposed&&run===epoch)say(error.message);throw error;}}
 async function refresh(){const run=++epoch;const result=await api.catalog();if(disposed||run!==epoch)return;names=result;render();}
 async function apply(remember){const captured=role;if(!captured)throw Error('请先打开单人角色卡');await api.apply(captured,profile,remember);if(book&&role===captured)await loadBook(book);}
 function renderEntries(parent,state){
  if(!book||!data)return;
  const c=card(parent,`条目 · ${book}`);c.append(el('p','默认保持原样；仅修改启用开关，仍遵循原本的触发规则。保存组合后生效。'));
  const all=el('div',null,'amin-toolbar');all.setAttribute('aria-label','整本世界书条目操作');c.append(all);
  for(const [mode,label]of [['on','全部启用'],['off','全部关闭'],['keep','全部恢复原样']])button(all,label,()=>{
   if(mode==='keep')profile.entries[book]={};else for(const id of Object.keys(data.entries))setRule(id,mode);
   drawList();say(`「${book}」已设置${label}，保存组合或临时应用后生效。`);
  }).disabled=mode!=='keep'&&!Object.keys(data.entries).length;
  c.append(el('p','整本操作包含搜索结果之外的所有条目；恢复原样会撤销本书的条目覆盖，不撤下世界书。'));
  const list=el('div');search(c,'搜索条目名称、UID 或正文',entryQuery,v=>{entryQuery=v;drawList();});
  const bar=el('div',null,'amin-toolbar');c.append(bar);
  for(const [mode,label]of modes)button(bar,'所选'+label,()=>{for(const id of selected)setRule(id,mode);drawList();});
  button(bar,'仅启用所选条目',()=>{if(!selected.size)throw Error('请先勾选要启用的条目');for(const id of Object.keys(data.entries))setRule(id,selected.has(id)?'on':'off');drawList();say('已设置：所选条目启用，其余关闭。保存组合后生效。');});
  c.append(list);function drawList(){list.replaceChildren();
   const entries=Object.entries(data.entries).filter(([id,e])=>`${id} ${e.comment??''} ${e.content??''}`.toLowerCase().includes(entryQuery.toLowerCase()));
   button(list,'勾选搜索结果',()=>{entries.forEach(([id])=>selected.add(id));drawList();});button(list,'清空勾选',()=>{selected.clear();drawList();});
   for(const [id,e]of entries){
    const row=el('div',null,'amin-wb-entry');check(row,e.comment||`条目 ${id}`,selected.has(id),v=>v?selected.add(id):selected.delete(id));
    const owned=state.session.entries.find(r=>r.book===book&&r.id===id),original=owned?owned.before.value===true:e.disable===true;
    row.append(el('p',`UID ${id} · 原状态：${original?'关闭':'启用'} → 当前：${e.disable===true?'关闭':'启用'}${owned?' · 插件接管':''}`));
    const select=el('select');select.setAttribute('aria-label',`条目 ${id} 的角色设置`);for(const [value,label]of modes){const o=el('option',label);o.value=value;select.append(o);}select.value=profile.entries[book]?.[id]??'keep';select.onchange=()=>setRule(id,select.value);row.append(select);
    const detail=el('details');detail.append(el('summary','查看原文'),el('pre',e.content??''));row.append(detail);
    if(owned)button(row,'保留此状态',async()=>{await api.keepEntry(book,id);await loadBook(book);});list.append(row);
   }
   if(!entries.length)list.append(el('p','没有匹配条目'));
  }drawList();
 }
 function render(){
  if(disposed)return;const current=api.context();if(current?.id!==role){role=current?.id;profile=api.profile();book='';data=null;epoch++;}
  const state=api.snapshot();intro.textContent=current?`${current.name} · 角色专属全局组合`:'打开单人角色卡后可设置专属组合；群聊不套用组合';
  tabs.replaceChildren();for(const name of ['角色组合','展示范围','接管记录']){const b=button(tabs,name,()=>{tab=name;render();});b.setAttribute('aria-pressed',String(tab===name));}
  say(api.message()||'只撤回插件自己接管的改动。');body.replaceChildren();
  const toolbar=el('div',null,'amin-toolbar');body.append(toolbar);button(toolbar,'刷新列表',refresh);button(toolbar,state.paused?'恢复自动应用':'暂停自动应用',()=>api.pause(!state.paused));
  if(tab==='展示范围'){
   const c=card(body,'选择插件内展示的世界书');c.append(el('p','展示选择不改变全局启用状态，也不会撤销角色组合。'));
   const list=el('div');search(c,'搜索世界书',query,v=>{query=v;draw();});c.append(list);
   function draw(){list.replaceChildren();for(const name of names.filter(n=>n.toLowerCase().includes(query.toLowerCase())))check(list,name,api.snapshot().visible.includes(name),async on=>{try{const visible=api.snapshot().visible.filter(n=>n!==name);if(on)visible.push(name);await api.setVisible(visible);}catch(e){say(e.message);}});}draw();return;
  }
  if(tab==='接管记录'){
   const logs=fold(body,'logs',`操作提示 · ${api.messages().length} 条`);for(const text of api.messages())logs.append(el('p',text));
   button(body,'撤回全部插件改动并暂停',()=>api.withdraw());const c=card(body,'本次接管');
   for(const name of state.session.books){const row=el('div',null,'amin-toolbar');row.append(el('span',name+' · 插件临时启用'));button(row,'保留为全局启用',()=>api.keepBook(name));c.append(row);}
   const groups=new Map();for(const r of state.session.entries){if(!groups.has(r.book))groups.set(r.book,[]);groups.get(r.book).push(r);}
   for(const [name,records]of groups){const group=fold(c,'record:'+name,`${name} · ${records.length} 个条目改动`);for(const r of records){const row=el('div',null,'amin-toolbar');row.append(el('span',`条目 ${r.id} · ${r.before.value===true?'关闭':'启用'} → ${r.after.value?'关闭':'启用'}`));button(row,'保留此状态',()=>api.keepEntry(r.book,r.id));group.append(row);}}
   if(!state.session.books.length&&!state.session.entries.length)c.append(el('p','当前没有接管项目'));return;
  }
  const actions=el('div',null,'amin-toolbar');body.append(actions);
  button(actions,'保存角色组合并应用',()=>apply(true),true).disabled=!role;
  button(actions,'仅本次临时应用',()=>apply(false)).disabled=!role;
  button(actions,'重新应用已保存组合',async()=>{profile=api.profile();await api.apply(role,profile,true);await api.sync(true);if(book)await loadBook(book);}).disabled=!role;
  body.append(el('p',state.paused?'自动应用已暂停，保存只记录设置；恢复后生效。':'离开角色时撤回接管项目；同角色切换聊天保持组合。'));
  if(!state.visible.length)button(body,'选择要展示的世界书',()=>{tab='展示范围';render();},true);
  const picker=fold(body,'book-picker',`选择启用的世界书 · 已选 ${profile.books.length} 本`);
  picker.append(el('p','勾选后自动保存并应用当前角色组合；取消勾选只撤回插件接管的改动。'));
  const choices=el('div',null,'amin-wb-choices');picker.append(choices);
  const globals=api.globals();for(const name of state.visible){
   const exists=names.includes(name),status=!exists?'世界书不存在或已改名':state.session.books.includes(name)?'插件临时启用':globals.includes(name)?'已全局启用（非插件接管）':'未全局启用';
   const row=el('div',null,'amin-wb-entry');choices.append(row);
   check(row,name,profile.books.includes(name),async on=>{
    const captured=role;selecting=true;profile.books=profile.books.filter(n=>n!==name);if(on)profile.books.push(name);profile.entries[name]??={};render();let failure='';
    try{await api.apply(captured,profile,true);}catch(error){failure=error.message;}finally{selecting=false;render();if(failure)say(failure);}
   }).disabled=!role||selecting||(!exists&&!profile.books.includes(name));
   row.append(el('small',status));
  }
  const activeBooks=profile.books.filter(name=>names.includes(name)&&globals.includes(name));
  const entryPicker=el('label','当前角色已启用的世界书'),select=el('select');select.setAttribute('aria-label','当前角色已启用的世界书');
  const placeholder=el('option',activeBooks.length?'选择一本世界书查看条目':'当前角色组合没有已启用的世界书');placeholder.value='';select.append(placeholder);
  for(const name of activeBooks){const option=el('option',name);option.value=name;select.append(option);}
  select.value=activeBooks.includes(book)?book:'';select.disabled=!role||selecting||!activeBooks.length;
  select.onchange=async()=>{const name=select.value;if(!name){epoch++;book='';data=null;render();return;}try{await loadBook(name);}catch(error){say(error.message);}};
  entryPicker.append(select);body.append(entryPicker);
  if(activeBooks.includes(book))renderEntries(body,state);
  const hidden=profile.books.filter(n=>!state.visible.includes(n));if(hidden.length)body.append(el('p',`组合中另有 ${hidden.length} 本未在此展示；可在展示范围中选中管理。`));
 }
 const unsubscribe=api.subscribe(render);try{await refresh();}catch(error){disposed=true;epoch++;unsubscribe();page.remove();throw error;}
 return {open:refresh,dispose(){disposed=true;epoch++;unsubscribe();page.remove();}};
}
