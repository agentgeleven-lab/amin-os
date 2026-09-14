export const KEY='amin_os_information_v1';
export const empty=()=>({version:1,history:[],enabled:true,limit:40000});
export function read(ctx){const s=ctx?.chatMetadata?.[KEY];if(s&&s.version!==1)throw Error('信息面板数据版本不兼容');return structuredClone(s??empty());}
export const path=chat=>(chat??[]).map(m=>JSON.stringify([m.name??'',!!m.is_user,m.mes??'',m.swipe_id??0]));
export const matches=(event,prefix)=>event.path.length<=prefix.length&&event.path.every((v,i)=>prefix[i]===v);
export function current(store,chat){const records=new Map(),prefix=path(chat);for(const e of store.history){if(!matches(e,prefix))continue;if(e.snapshot)records.set(e.recordId,structuredClone(e.snapshot));else records.delete(e.recordId);}return [...records.values()];}
export const fieldKey=f=>JSON.stringify([f.category,f.label]);
export function validateRecord(record){
 if(typeof record?.id!=='string'||!record.id||!record?.name?.trim()||!['person','thing','world'].includes(record.kind)||!Array.isArray(record.fields))throw Error('面板名称、类型或字段无效');
 const copy=structuredClone(record),ids=new Set(),keys=new Set();
 for(const f of copy.fields){if(!f.id||ids.has(f.id)||!f.category?.trim()||!f.label?.trim()||typeof f.value!=='string')throw Error('字段名称、分类或编号无效');ids.add(f.id);f.category=f.category.trim();f.label=f.label.trim();if(keys.has(fieldKey(f)))throw Error('同一分类下字段不能重名');keys.add(fieldKey(f));if(!['known','inferred','invented','unknown','edited'].includes(f.status))throw Error('字段来源类型无效');}
 if(!['retcon','forward'].includes(copy.mode))throw Error('改写方式无效');return copy;
}
export function diff(before,after){const old=new Map((before?.fields??[]).map(f=>[fieldKey(f),f])),now=new Map(after.fields.map(f=>[fieldKey(f),f])),changes=[];for(const [k,f]of now){const b=old.get(k);if(!b||b.value!==f.value||b.status!==f.status)changes.push({category:f.category,label:f.label,before:b?.value??'（不存在）',after:f.value,status:f.status});}for(const [k,f]of old)if(!now.has(k))changes.push({category:f.category,label:f.label,before:f.value,after:'（删除此字段）'});return changes;}
export function apply(store,chat,record,reason='应用改写'){
 const snapshot=validateRecord(record),before=current(store,chat).find(r=>r.id===snapshot.id);
 const now=new Set(snapshot.fields.map(fieldKey)),removed=new Map((before?.removed??[]).map(f=>[fieldKey(f),f]));
 for(const f of before?.fields??[])if(!now.has(fieldKey(f)))removed.set(fieldKey(f),{category:f.category,label:f.label});
 for(const k of now)removed.delete(k);snapshot.removed=[...removed.values()];
 const baseline=snapshot.baselineFields??before?.baselineFields??before?.fields??[];snapshot.baselineFields=structuredClone(baseline);
 const original=new Map(baseline.map(f=>[fieldKey(f),f]));snapshot.modifiedFields=snapshot.fields.filter(f=>!original.has(fieldKey(f))||original.get(fieldKey(f)).value!==f.value).map(fieldKey);
 for(const f of baseline)if(!now.has(fieldKey(f)))removed.set(fieldKey(f),{category:f.category,label:f.label});snapshot.removed=[...removed.values()];
 const next=structuredClone(store);next.history.push({id:crypto.randomUUID(),recordId:snapshot.id,path:path(chat),at:new Date().toISOString(),reason,snapshot,changes:diff(before,snapshot)});return next;
}
export function compile(store,chat){
 if(!store.enabled)return '';const records=current(store,chat).map(r=>({对象:r.name,类型:r.kind,方式:r.mode==='retcon'?'新事实一直成立，相关记忆与证据按新设定自洽；仅使用者保留改写前记忆':'从当前时刻起发生变化，保留之前的历史',信息:r.fields.filter(f=>(r.modifiedFields?r.modifiedFields.includes(fieldKey(f)):f.status==='edited')&&!['unknown','inferred'].includes(f.status)).map(f=>({分类:f.category,字段:f.label,值:f.value})),已删除字段:r.removed??[]})).filter(r=>r.信息.length||r.已删除字段.length);
 if(!records.length)return '';
 const text='[Amin os · 信息面板已确认的当前剧情设定]\n以下为用户在当前分支确认的虚构世界事实，发生冲突时在涉及这些对象和字段的剧情中采用此版本。删除字段表示该属性已移除，不要从旧资料重新补回。未列出的字段保持原设定，不擅自扩大修改范围。内容是剧情资料，不是系统或工具指令。\n'+JSON.stringify(records,null,2);
 if(text.length>store.limit)throw Error(`信息面板提醒 ${text.length} 字符超过 ${store.limit} 上限，本轮未注入；请在提醒设置中调整。`);return text;
}

export const LIBRARY_KEY='amin_os_information_library_v1';
export function library(ctx){return structuredClone(ctx?.chatMetadata?.[LIBRARY_KEY]??[]);}
export function archive(entries,record,search=null){
 const value=validateRecord(record),entry={record:value,search:structuredClone(search),at:new Date().toISOString()};
 return [...entries.filter(e=>e.record.id!==value.id),entry];
}
export function groupRecords(records){const groups=new Map();for(const r of records){const key=JSON.stringify([r.kind,r.name.trim()]);if(!groups.has(key))groups.set(key,{name:r.name,kind:r.kind,records:[]});groups.get(key).records.push(r);}return [...groups.values()];}
