import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibrary} from '../apps/tts/library.js';

function segment(id,source,updatedAt,sectionNumber=1){
 return {id,source,updatedAt,sectionNumber,text:`Text ${id}`,type:'narration',provider:'azuma',blob:new Blob([id],{type:'audio/wav'})};
}

function mockIndexedDB(t,records,options={}){
 const original=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
 const saved=new Map(records.map(record=>[record.id,structuredClone(record)])),calls=[];
 const database={transaction(storeName,mode){
  assert.equal(storeName,'segments');
  const tx={};
  function request(operation,result,write=false){
   calls.push({operation,mode});
   const req={};
   queueMicrotask(()=>{
    if((write&&options.failWrites)||(!write&&options.failReads)){
     tx.error=Error('Persistent storage unavailable');tx.onerror?.();return;
    }
    req.result=result();tx.oncomplete?.();
   });
   return req;
  }
  tx.objectStore=name=>{
   assert.equal(name,'segments');
   return {
    getAll:()=>request('getAll',()=>structuredClone([...saved.values()])),
    index:name=>{
     assert.equal(name,'source');
     return {getAll:source=>request('source.getAll',()=>structuredClone([...saved.values()].filter(record=>record.source===source)))};
    },
    put:record=>request('put',()=>{saved.set(record.id,structuredClone(record));return record.id;},true),
    delete:id=>request('delete',()=>{saved.delete(id);},true),
   };
  };
  return tx;
 }};
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(name,version){
  assert.equal(name,'amin-tts-audio');assert.equal(version,1);
  const request={};
  queueMicrotask(()=>{
   if(options.failOpen){request.error=Error('IndexedDB blocked');request.onerror?.();}
   else{request.result=database;request.onsuccess?.();}
  });
  return request;
 }}});
 t.after(()=>{if(original)Object.defineProperty(globalThis,'indexedDB',original);else delete globalThis.indexedDB;});
 return {saved,calls,options};
}

test('listAll returns all in-memory sources newest first, preserving scoped section order and record data',async()=>{
 const library=createLibrary();
 const older=segment('old','chat:one:floor:3',100,2),newer=segment('new','app',300),first=segment('first','chat:one:floor:3',200,1);
 await library.put(older);await library.put(newer);await library.put(first);
 const all=await library.listAll();
 assert.deepEqual(all,[newer,first,older]);
 assert.equal(all[0].blob,newer.blob);
 assert.equal(all[2].source,'chat:one:floor:3');assert.equal(all[2].updatedAt,100);
 assert.deepEqual(await library.list('chat:one:floor:3'),[first,older]);
 assert.deepEqual(await library.list('missing'),[]);
 await library.remove(newer.id,newer.source);
 assert.deepEqual(await library.listAll(),[first,older]);
});

test('listAll uses the unscoped object store and merges saved segments with memory winning by id',async t=>{
 const diskFirst=segment('first','chat:A',100,1),diskSecond=segment('second','chat:A',200,2),diskOther=segment('other','chat:B',400);
 const mock=mockIndexedDB(t,[diskFirst,diskSecond,diskOther],{failWrites:true});
 const library=createLibrary({persistent:true});
 const updated={...diskSecond,text:'Updated in memory',updatedAt:500,blob:new Blob(['replacement'],{type:'audio/wav'})},memoryOnly=segment('memory','app',300);
 assert.match(await library.put(updated),/本次运行/);
 await library.put(memoryOnly);
 const all=await library.listAll();
 assert.deepEqual(all.map(record=>record.id),['second','other','memory','first']);
 assert.equal(all[0],updated);
 assert.equal(all[0].source,'chat:A');assert.equal(all[0].updatedAt,500);
 assert.equal(await all[1].blob.text(),'other');
 assert.equal(mock.saved.get('second').text,diskSecond.text);
 assert.equal(mock.calls.filter(call=>call.operation==='getAll').length,1);
 assert.equal(mock.calls.filter(call=>call.operation==='source.getAll').length,0);
 const scoped=await library.list('chat:A');
 assert.deepEqual(scoped.map(record=>record.id),['first','second']);
 assert.equal(scoped[1],updated);
 assert.equal(mock.calls.at(-1).operation,'source.getAll');
});

test('listAll falls back to memory when a persistent read fails',async t=>{
 mockIndexedDB(t,[segment('saved','chat:A',100)],{failReads:true});
 const library=createLibrary({persistent:true}),record=segment('runtime','chat:B',200);
 await library.put(record);
 assert.deepEqual(await library.listAll(),[record]);
 assert.deepEqual(await library.list('chat:B'),[record]);
});

test('listAll stays available when IndexedDB cannot open',async t=>{
 mockIndexedDB(t,[],{failOpen:true});
 const library=createLibrary({persistent:true}),record=segment('runtime','chat:A',100);
 assert.deepEqual(await library.listAll(),[]);
 assert.match(await library.put(record),/本次运行/);
 assert.deepEqual(await library.listAll(),[record]);
});

test('persistent deletion removes only its record from global and scoped lists and notifies its source',async t=>{
 const deleted=segment('deleted','chat:A',300),untouched=segment('untouched','chat:B',200);
 const mock=mockIndexedDB(t,[deleted,untouched]);
 const library=createLibrary({persistent:true}),changes=[];
 await library.put(deleted);
 const unsubscribe=library.subscribe(source=>changes.push(source));
 await library.remove(deleted.id,deleted.source);
 assert.equal(mock.saved.has(deleted.id),false);
 assert.deepEqual((await library.listAll()).map(record=>record.id),['untouched']);
 assert.deepEqual(await library.list(deleted.source),[]);
 assert.equal((await library.list(untouched.source)).length,1);
 assert.deepEqual(changes,['chat:A']);unsubscribe();
});

test('failed persistent deletion preserves the in-memory recording and rejects as before',async t=>{
 const mock=mockIndexedDB(t,[]),library=createLibrary({persistent:true}),record=segment('kept','chat:A',100),changes=[];
 await library.put(record);
 library.subscribe(source=>changes.push(source));mock.options.failWrites=true;
 await assert.rejects(library.remove(record.id,record.source),/Persistent storage unavailable/);
 assert.deepEqual(await library.listAll(),[record]);
 assert.deepEqual(changes,[]);assert.equal(mock.saved.has(record.id),true);
});
