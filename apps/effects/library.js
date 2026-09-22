export const LIBRARY_KEY='amin_os_ability_library_v1';
export const UNGROUPED='未分组';
export const emptyLibrary=()=>({version:1,skills:[],groups:[],imported:[],trash:[]});
export const abilityGroup=skill=>typeof skill?.ui?.group==='string'&&skill.ui.group.trim()?skill.ui.group:UNGROUPED;
export function groupNames(store){return [UNGROUPED,...new Set([...(store.groups??[]),...store.skills.map(abilityGroup)].filter(n=>n!==UNGROUPED))];}
export const libraryStamp=store=>JSON.stringify({skills:store.skills,groups:groupNames(store)});

// Keep legacy variants rather than silently replacing an independently edited ability.
export function mergeLibrary(raw,legacy=[]){
 if(raw&&(raw.version!==1||!Array.isArray(raw.skills)||!Array.isArray(raw.imported)))throw Error('能力库数据版本不兼容，请先备份');
 const library=structuredClone(raw??emptyLibrary());
 library.trash??=[];
 if(!Array.isArray(library.trash))throw Error('已删除能力数据损坏，请先备份');
 if(library.groups!==undefined&&(!Array.isArray(library.groups)||library.groups.some(n=>typeof n!=='string'||!n.trim())))throw Error('能力分组数据损坏，请先备份');
 for(const skill of legacy){
  const fingerprint=JSON.stringify(skill);
  if(library.imported.includes(fingerprint))continue;
  if(!library.skills.some(s=>JSON.stringify(s)===fingerprint)){
   const copy=structuredClone(skill),base=copy.id;let suffix=1;
   while(library.skills.some(s=>s.id===copy.id))copy.id=base+'-legacy-'+suffix++;
   library.skills.push(copy);
  }
  library.imported.push(fingerprint);
 }
 library.groups=groupNames(library).filter(n=>n!==UNGROUPED);
 return library;
}
function validName(value){
 const name=typeof value==='string'?value.trim():'';
 if(!name||name.length>40)throw Error('分组名称需为 1–40 字');
 if(name===UNGROUPED)throw Error('“未分组”是保留分组');
 return name;
}
export function addGroup(store,value){
 const name=validName(value),next=structuredClone(store);
 if(groupNames(next).includes(name))throw Error('已有同名分组');
 next.groups=[...groupNames(next).filter(n=>n!==UNGROUPED),name];return next;
}
export function renameGroup(store,from,value){
 const name=validName(value),next=structuredClone(store),names=groupNames(next);
 if(from===UNGROUPED)throw Error('不能重命名“未分组”');
 if(!names.includes(from))throw Error('分组已不存在，请刷新');
 if(from!==name&&names.includes(name))throw Error('已有同名分组');
 next.groups=names.filter(n=>n!==UNGROUPED).map(n=>n===from?name:n);
 for(const skill of next.skills)if(abilityGroup(skill)===from)skill.ui={...skill.ui,group:name};
 return next;
}
export function removeGroup(store,name){
 const next=structuredClone(store),names=groupNames(next);
 if(name===UNGROUPED)throw Error('不能删除“未分组”');
 if(!names.includes(name))throw Error('分组已不存在，请刷新');
 next.groups=names.filter(n=>n!==name&&n!==UNGROUPED);
 for(const skill of next.skills)if(abilityGroup(skill)===name)skill.ui={...skill.ui,group:UNGROUPED};
 return next;
}
export function moveAbility(store,id,group){
 const next=structuredClone(store),skill=next.skills.find(s=>s.id===id);
 if(!skill)throw Error('能力已不存在，请刷新');
 if(!groupNames(next).includes(group))throw Error('分组已不存在，请刷新');
 skill.ui={...skill.ui,group};return next;
}
export function deleteAbility(store,id){
 const next=structuredClone(store),index=next.skills.findIndex(s=>s.id===id);
 if(index<0)throw Error('能力已不存在，请刷新列表');
 const [skill]=next.skills.splice(index,1);
 next.trash??=[];next.trash.push({skill,index,deletedAt:new Date().toISOString()});
 return next;
}
export function restoreAbility(store,id){
 const next=structuredClone(store),index=(next.trash??[]).findIndex(e=>e.skill.id===id);
 if(index<0)throw Error('找不到已删除的能力');
 if(next.skills.some(s=>s.id===id))throw Error('存在同编号能力，请先处理冲突');
 const [entry]=next.trash.splice(index,1);
 if(!groupNames(next).includes(abilityGroup(entry.skill)))entry.skill.ui={...entry.skill.ui,group:UNGROUPED};
 next.skills.splice(Math.min(entry.index,next.skills.length),0,entry.skill);
 return next;
}
