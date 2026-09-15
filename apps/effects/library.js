export const LIBRARY_KEY='amin_os_ability_library_v1';
export const emptyLibrary=()=>({version:1,skills:[],imported:[],trash:[]});

// Keep legacy variants rather than silently replacing an independently edited ability.
export function mergeLibrary(raw,legacy=[]){
 if(raw&&(raw.version!==1||!Array.isArray(raw.skills)||!Array.isArray(raw.imported)))throw Error('能力库数据版本不兼容，请先备份');
 const library=structuredClone(raw??emptyLibrary());
 library.trash??=[];
 if(!Array.isArray(library.trash))throw Error('已删除能力数据损坏，请先备份');
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
 return library;
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
 next.skills.splice(Math.min(entry.index,next.skills.length),0,entry.skill);
 return next;
}
