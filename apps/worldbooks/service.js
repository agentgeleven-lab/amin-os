export const KEY='amin_os_worldbooks_v1';
export const emptyState=()=>({version:1,visible:[],profiles:{},paused:false,session:{role:null,books:[],entries:[],spec:{}}});
export function character(ctx){
 if(ctx.groupId!==undefined&&ctx.groupId!==null&&ctx.groupId!=='')return null;
 const c=ctx.characters?.[ctx.characterId];return c?.avatar?{id:c.avatar,name:c.name??c.avatar}:null;
}
export function normalizeProfile(value={}){
 const books=[...new Set((value.books??[]).filter(x=>typeof x==='string'&&x))],entries={};
 for(const book of books){Object.defineProperty(entries,book,{value:{},enumerable:true,writable:true,configurable:true});for(const [id,mode]of Object.entries(value.entries?.[book]??{}))if(mode==='on'||mode==='off')Object.defineProperty(entries[book],id,{value:mode,enumerable:true,writable:true,configurable:true});}
 return {books,entries};
}
const entryKey=(book,id)=>JSON.stringify([book,id]);
const flag=e=>Object.hasOwn(e,'disable')?{present:true,value:e.disable}:{present:false};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function writeFlag(e,f){if(f.present)e.disable=f.value;else delete e.disable;}
export function createManager({host,context,initial=emptyState(),persist}){
 const state=structuredClone(initial),listeners=new Set(),messages=[];let queue=Promise.resolve(),message='',temporary=null;
 state.session??=emptyState().session;state.profiles??={};state.visible??=[];
 const save=()=>persist(structuredClone(state));
 const emit=()=>{for(const fn of listeners)fn();};
 const report=text=>{message=text;messages.push(text);if(messages.length>20)messages.shift();emit();};
 const enqueue=fn=>{const run=queue.then(fn);queue=run.catch(e=>report(e.message));return run.finally(emit);};
 const check=role=>{if(character(context())?.id!==role)throw Error('角色已切换，未继续应用；请刷新查看当前组合');};
 async function restoreEntry(record){
  if(!(await host.names()).includes(record.book)){report(`世界书已不存在：${record.book}，已释放旧名称接管；未匹配其他书`);return;}
  const data=await host.load(record.book),entry=data.entries?.[record.id];
  if(!entry){report(`条目已不存在：${record.book} / ${record.id}，已释放接管`);return;}
  if(equal(flag(entry),record.before))return;
  if(!equal(flag(entry),record.after)){report(`保留外部修改：${record.book} / ${record.id}`);return;}
  writeFlag(entry,record.before);await host.save(record.book,data);
 }
 async function removeEntries(predicate){
  for(const record of [...state.session.entries])if(predicate(record)){
   await restoreEntry(record);state.session.entries.splice(state.session.entries.indexOf(record),1);save();
  }
 }
 async function removeBooks(predicate){
  for(const name of [...state.session.books])if(predicate(name)){
   await host.setGlobal(name,false);state.session.books=state.session.books.filter(x=>x!==name);save();
  }
 }
 async function clear(){await removeEntries(()=>true);await removeBooks(()=>true);state.session={role:null,books:[],entries:[],spec:{}};temporary=null;save();}
 async function reconcile(force=false){
  const role=character(context())?.id??null;
  if(state.session.role!==role){await clear();state.session.role=role;save();}
  if(state.paused||!role)return;
  const profile=normalizeProfile(temporary?.role===role?temporary.profile:state.profiles[role]);
  const wanted={};for(const book of profile.books)for(const [id,mode]of Object.entries(profile.entries[book]))wanted[entryKey(book,id)]=mode;
  await removeEntries(r=>!wanted[entryKey(r.book,r.id)]||wanted[entryKey(r.book,r.id)]!==state.session.spec[entryKey(r.book,r.id)]);
  await removeBooks(name=>!profile.books.includes(name));
  const old=state.session.spec,next={};const available=await host.names();
  for(const book of profile.books){
   check(role);const bk=entryKey(book,'$book');next[bk]=true;
   if(!available.includes(book)){report(`世界书不存在或已改名：${book}，请手动重新选择`);continue;}
   if(force||!old[bk]){
    if(!host.globals().includes(book)){
     if(!state.session.books.includes(book)){state.session.books.push(book);save();}
     await host.setGlobal(book,true);
    }
   }
   const rules=profile.entries[book];
   for(const [id,mode]of Object.entries(rules)){
    const key=entryKey(book,id);next[key]=mode;
    if(!force&&old[key]===mode)continue;
    const data=await host.load(book);check(role);const entry=data.entries?.[id];
    if(!entry){report(`条目不存在：${book} / ${id}`);continue;}
    const before=flag(entry),after={present:true,value:mode==='off'};
    const existing=state.session.entries.find(r=>r.book===book&&r.id===id);
    if(existing&&!equal(before,existing.after)){
     state.session.entries.splice(state.session.entries.indexOf(existing),1);save();
    }
    if(equal(before,after))continue;
    if(!state.session.entries.some(r=>r.book===book&&r.id===id)){state.session.entries.push({book,id,before,after});save();}
    writeFlag(entry,after);await host.save(book,data);
   }
  }
  state.session.spec=next;save();
 }
 async function sync(force=false){
  const started=character(context())?.id??null;
  try{await reconcile(force);}finally{
   // A switch during an awaited read/write must always clean up the previous role.
   if(started!==(character(context())?.id??null))queueMicrotask(()=>api.sync().catch(()=>{}));
  }
 }
 const api={
  snapshot:()=>structuredClone(state),context:()=>character(context()),message:()=>message,messages:()=>[...messages],
  subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  catalog:()=>host.names(),globals:()=>host.globals(),load:name=>host.load(name),
  sync:(force=false)=>enqueue(()=>sync(force)),
  setVisible:names=>enqueue(async()=>{state.visible=[...new Set(names)];save();}),
  profile:()=>normalizeProfile(state.profiles[character(context())?.id]),
  apply:(role,profile,remember=true)=>{const normalized=normalizeProfile(profile);return enqueue(async()=>{
   check(role);
   if(remember){Object.defineProperty(state.profiles,role,{value:normalized,enumerable:true,writable:true,configurable:true});temporary=null;}else temporary={role,profile:normalized};
   save();await sync();report(state.paused?'已保存设置；自动应用已暂停':remember?'已保存角色组合并应用':'已临时应用，离开角色后撤回');
  });},
  pause:value=>enqueue(async()=>{state.paused=value;save();if(!value)await sync(true);report(value?'已暂停自动应用；切换角色仍会撤回旧组合':'已恢复自动应用');}),
  withdraw:()=>enqueue(async()=>{state.paused=true;save();await clear();report('已撤回插件改动，并暂停自动应用');}),
  keepBook:name=>enqueue(async()=>{state.session.books=state.session.books.filter(x=>x!==name);save();report('已保留为全局启用，不再由插件撤下');}),
  keepEntry:(book,id)=>enqueue(async()=>{state.session.entries=state.session.entries.filter(r=>r.book!==book||r.id!==id);save();report('已保留此条目状态，不再自动恢复');}),
 };return api;
}
