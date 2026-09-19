export const ROOT = '势力资料';
export const GROUPS = ['organizations', 'alliances', 'regions'];
export const LABELS = { organizations:'组织', alliances:'联盟／阵营', regions:'地区' };
export const uid = () => 'id_' + crypto.randomUUID().replaceAll('-', '');
export const clone = value => structuredClone(value);
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const empty = () => ({version:1, name:'', summary:'', time:'', organizations:{}, alliances:{}, regions:{}});
export const FIELDS = {
 organizations:{name:'名称',type:'类型',summary:'概况',background:'背景',leadership:'领导与结构',ideology:'理念与思潮',goals:'目标与当前诉求',capabilities:'特质与能力',status:'当前状况',affairs:'正在进行的事项',source:'资料依据',certainty:'资料性质',updatedAt:'资料时间'},
 alliances:{name:'名称',type:'正式联盟／松散阵营',summary:'概况',background:'成立背景',goals:'共同目标',governance:'决策机制',obligations:'成员义务',resources:'共同资源',divisions:'内部分歧',status:'当前状况',affairs:'当前事项',source:'资料依据',certainty:'资料性质',updatedAt:'资料时间'},
 regions:{name:'名称',type:'地区类型',summary:'概况',background:'背景',population:'人口或适用规模',economy:'产业与资源',infrastructure:'设施与交通',society:'社会状况',security:'治安与环境',status:'当前状况',affairs:'当前事项',source:'资料依据',certainty:'资料性质',updatedAt:'资料时间'},
};
export const LINKS = { organizations:{relations:'对外关系'}, alliances:{members:'成员与身份'}, regions:{controllers:'归属、管理与经营关系',parent:'上级地区'} };
export function entity(group, name='未命名') {
 if (!GROUPS.includes(group)) throw Error('未知资料类型');
 const out=Object.fromEntries(Object.keys(FIELDS[group]).map(k=>[k,'']));
 out.name=name;out.certainty='未明确';out.metrics=[];
 if(group==='organizations')out.relations=[];
 if(group==='alliances')out.members=[];
 if(group==='regions'){out.controllers=[];out.parent=null;}
 return out;
}
const safeId = s => typeof s==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(s) && !['constructor','prototype','__proto__'].includes(s);
const text = (v,label,max=12000) => {if(typeof v!=='string'||v.length>max)throw Error(label+'必须是长度受限的文本');return v;};
function validateMetrics(list) {
 if(!Array.isArray(list)||list.length>80)throw Error('指标必须是数组且不超过80项');
 const seen=new Set();
 for(const m of list){
  if(!object(m)||!safeId(m.key)||seen.has(m.key))throw Error('指标key非法或重复');seen.add(m.key);
  for(const k of ['label','unit','source'])text(m[k]??'',k,1000);
  if(!m.label?.trim())throw Error('指标名称不能为空');
  if(!['number','range','text','unknown'].includes(m.kind))throw Error('未知指标类型');
  if(m.kind==='number'&&!Number.isFinite(m.value))throw Error('指标数值必须是有限数字');
  if(m.kind==='range'&&(!Array.isArray(m.value)||m.value.length!==2||!m.value.every(Number.isFinite)||m.value[0]>m.value[1]))throw Error('指标范围无效');
  if(m.kind==='text')text(m.value,'指标描述');
  if(m.kind==='unknown'&&m.value!==null)throw Error('未知指标的value必须为null');
  if(Object.keys(m).some(k=>!['key','label','unit','source','kind','value'].includes(k)))throw Error('指标含未知字段');
 }
}
export function validate(input) {
 if(!object(input)||input.version!==1)throw Error('势力资料结构/版本不兼容，未覆盖');
 if(Object.keys(input).some(k=>!['version','name','summary','time',...GROUPS].includes(k)))throw Error('资料含未定义的根字段');
 const doc=clone(input);
 for(const k of ['name','summary','time'])text(doc[k],k);
 const ids=new Set();
 for(const group of GROUPS){
  if(!object(doc[group])||Object.keys(doc[group]).length>200)throw Error(LABELS[group]+'格式不正确或超过200项');
  for(const [id,e]of Object.entries(doc[group])){
   if(!safeId(id)||ids.has(id)||!object(e))throw Error('资料ID非法、重复或对象无效');ids.add(id);
   const allowed=[...Object.keys(FIELDS[group]),'metrics',...Object.keys(LINKS[group])];
   if(Object.keys(e).some(k=>!allowed.includes(k)))throw Error(e.name+'含未定义字段');
   for(const k of Object.keys(FIELDS[group]))text(e[k],LABELS[group]+'.'+k);
   if(!e.name.trim())throw Error('名称不能为空');validateMetrics(e.metrics);
  }
 }
 for(const group of GROUPS)for(const [id,e]of Object.entries(doc[group])){
  if(group==='regions'){
   if(e.parent!==null&&(!safeId(e.parent)||!Object.hasOwn(doc.regions,e.parent)||e.parent===id))throw Error('上级地区不存在或指向自身');
   const seen=new Set([id]);let parent=e.parent;
   while(parent){if(seen.has(parent))throw Error('地区层级存在循环');seen.add(parent);parent=doc.regions[parent]?.parent;}
  }
  const key=group==='organizations'?'relations':group==='alliances'?'members':'controllers';
  if(!Array.isArray(e[key])||e[key].length>200)throw Error('关联必须是数组且不超过200项');
  for(const link of e[key]){
   if(!object(link)||!safeId(link.organization)||!Object.hasOwn(doc.organizations,link.organization)||(group==='organizations'&&link.organization===id))throw Error(e.name+'关联的组织不存在或指向自身');
   text(link.role,'关联性质',1000);text(link.note,'关联说明');
   if(Object.keys(link).some(k=>!['organization','role','note'].includes(k)))throw Error('关联含未知字段');
  }
 }
 return doc;
}
export function read(raw){if(raw===undefined||raw===null||raw==='')return empty();return validate(typeof raw==='string'?JSON.parse(raw):raw);}
export function diff(before,after){
 const changes=[];
 for(const k of ['name','summary','time'])if(!equal(before[k],after[k]))changes.push({path:k,label:k,before:before[k],after:after[k]});
 for(const group of GROUPS)for(const id of new Set([...Object.keys(before[group]),...Object.keys(after[group])])){
  const a=before[group][id],b=after[group][id];
  if(!a||!b){changes.push({path:group+'.'+id,label:LABELS[group]+' · '+(b??a).name,before:a??null,after:b??null});continue;}
  for(const k of Object.keys(b))if(!equal(a[k],b[k]))changes.push({path:[group,id,k].join('.'),label:b.name+' · '+(FIELDS[group][k]??LINKS[group][k]??'指标'),before:a[k],after:b[k]});
 }
 return changes;
}
export function enforceLocks(before,after,locks=[]){
 for(const path of locks){const parts=path.split('.');if(parts.length!==3||!GROUPS.includes(parts[0]))throw Error('锁定路径无效');const [g,id,k]=parts;
  if(!equal(before[g]?.[id]?.[k],after[g]?.[id]?.[k]))throw Error('锁定资料不可修改：'+(before[g]?.[id]?.name??id)+' · '+k);
 }
}
export function mergeProposal(before,proposed,{mode='update',allowNew=false,groups=GROUPS,target=null,locks=[]}={}){
 const incoming=validate(proposed),next=clone(before);
 if(!['fill','replace','update'].includes(mode))throw Error('未知更新模式');
 for(const g of GROUPS){
  if(!groups.includes(g))continue;
  if(mode==='replace'&&!target){next[g]=incoming[g];continue;}
  for(const [id,e]of Object.entries(incoming[g])){
   if(target&&(target.group!==g||target.id!==id))continue;
   if(!next[g][id]){if(mode==='fill'||allowNew)next[g][id]=e;else throw Error('当前操作未允许新增主体：'+e.name);continue;}
   if(mode==='fill'){
    for(const [k,v]of Object.entries(e))if(next[g][id][k]===''||next[g][id][k]===null||(Array.isArray(next[g][id][k])&&!next[g][id][k].length))next[g][id][k]=v;
   }else next[g][id]=e;
  }
 }
 if(!target)for(const k of ['name','summary','time'])if(mode!=='fill'||!next[k])next[k]=incoming[k];
 const checked=validate(next);enforceLocks(before,checked,locks);return checked;
}
export function deleteEntity(doc,group,id){
 const next=clone(doc);delete next[group][id];
 if(group==='organizations')for(const g of GROUPS)for(const e of Object.values(next[g])){const key=g==='organizations'?'relations':g==='alliances'?'members':'controllers';e[key]=e[key].filter(l=>l.organization!==id);}
 if(group==='regions')for(const e of Object.values(next.regions))if(e.parent===id)e.parent=null;
 return validate(next);
}
export function rankMetrics(doc,{group='organizations',key,unit='',ascending=false}={}){
 const included=[],excluded=[];
 for(const [id,e]of Object.entries(doc[group]??{})){
  const m=e.metrics.find(m=>m.key===key);
  if(!m||m.kind!=='number'||m.unit!==unit){excluded.push({id,name:e.name,reason:'未知、非精确数值或单位不一致'});continue;}
  included.push({id,name:e.name,value:m.value});
 }
 included.sort((a,b)=>(ascending?1:-1)*(a.value-b.value));let rank=0,previous;
 included.forEach((e,i)=>{if(i===0||e.value!==previous)rank=i+1;e.rank=rank;previous=e.value;});
 return {included,excluded};
}
