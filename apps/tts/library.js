// Audio stays in this host's IndexedDB; API credentials are never persisted here.
export function createLibrary({persistent=false}={}){
 const memory=new Map(),listeners=new Set();let database;
 const open=()=>database??=(new Promise((resolve,reject)=>{const request=indexedDB.open('amin-tts-audio',1);request.onupgradeneeded=()=>{request.result.createObjectStore('segments',{keyPath:'id'}).createIndex('source','source');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}));
 async function transaction(mode,action){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('segments',mode),req=action(tx.objectStore('segments'));tx.oncomplete=()=>resolve(req.result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('音频保存失败'));});}
 return {
  async put(record){memory.set(record.id,record);let error;try{if(persistent)await transaction('readwrite',s=>s.put(record));}catch{error='音频仅保留在本次运行中：本机存储不可用或空间不足';}for(const fn of listeners)fn(record.source);return error;},
  async list(source){let saved=[];if(persistent){try{saved=await transaction('readonly',s=>s.index('source').getAll(source));}catch{}}const merged=new Map(saved.map(x=>[x.id,x]));for(const r of memory.values())if(r.source===source)merged.set(r.id,r);return [...merged.values()].sort((a,b)=>a.sectionNumber-b.sectionNumber||a.updatedAt-b.updatedAt);},
  async listAll(){let saved=[];if(persistent){try{saved=await transaction('readonly',s=>s.getAll());}catch{}}const merged=new Map(saved.map(x=>[x.id,x]));for(const r of memory.values())merged.set(r.id,r);return [...merged.values()].sort((a,b)=>b.updatedAt-a.updatedAt||a.sectionNumber-b.sectionNumber);},
  async remove(id,source){if(persistent)await transaction('readwrite',s=>s.delete(id));memory.delete(id);for(const fn of listeners)fn(source);},
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}
 };
}
export const audioLibrary=createLibrary({persistent:true});
