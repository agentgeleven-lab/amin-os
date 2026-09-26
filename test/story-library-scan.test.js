import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStoryLibrary } from '../apps/shared/story-library-scan.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';

async function fixture() {
    const nodes = new Map();
    const store = {get:async id=>nodes.get(id)??null,put:async(id,v)=>nodes.set(id,v),list:async()=>[...nodes.keys()]};
    const graph = createStoryStateGraph(store);
    const state = n => ({version:2,variables:{padding:'x'.repeat(4000),n},rules:{},jsonStringRoots:[]});
    const base = await graph.save(state(0)), next = await graph.save(state(1),{parentId:base}), other = await graph.save(state(2));
    const idx = await graph.save({kind:'amin-story-index',version:1,chat:'a',order:{0:'m'},messages:{m:{selected:0,candidates:{c:{swipe:0,stateId:next},c2:{swipe:1,stateId:other}}}},inheritedFrom:null});
    const marker = {version:2,owner:'amin-os/story-v2',baseStateId:base,indexId:idx};
    const entry = (id,kind='chat') => ({id,label:id,kind,chatMetadata:{amin_os_story_storage_v2:marker},chat:[]});
    return {store,nodes,graph,base,next,other,idx,entry,state};
}
test('all swipe candidates, delta parents and backup/shared owners counted uniquely',async()=>{
    const f=await fixture(); const orphan=await f.graph.save(f.state(99));
    const report=await scanStoryLibrary({store:f.store,census:{complete:true,entries:[f.entry('a'),f.entry('b','backup')],fingerprint:'stable'}});
    assert.equal(report.complete,true);assert.equal(report.summary.files,5);assert.equal(report.summary.sharedFiles,4);
    assert.deepEqual(report.candidates.map(x=>x.id),[orphan]);assert.equal(report.chats[0].exclusiveBytes,0);
    assert.equal(report.chats[0].bytes,report.summary.sharedBytes);assert.equal(report.deletionAuthorized,false);
});
test('inherited indexes and legacy unselected swipe parent refs stay protected',async()=>{
    const f=await fixture(); const child=await f.graph.save({kind:'amin-story-index',version:1,chat:'b',order:{},messages:{},inheritedFrom:{chat:'a',indexId:f.idx}});
    const e=f.entry('b');e.chatMetadata.amin_os_story_storage_v2.indexId=child;
    e.chat=[{mes:'x',swipe_info:[{extra:{amin_story_v2:{version:2,stateId:f.other,parentStateId:f.base}}}]}];
    const r=await scanStoryLibrary({store:f.store,census:{complete:true,entries:[e]}});
    assert.equal(r.complete,true);assert.equal(r.candidates.length,0);assert.equal(r.summary.referencedFiles,5);
});
test('unknown files, corrupt graphs and incomplete census block candidates but preserve observations',async()=>{
    const f=await fixture(); const orphan=await f.graph.save(f.state(99));
    f.nodes.get(f.next).digest='sha256:'+'f'.repeat(64);
    const r=await scanStoryLibrary({store:{...f.store,list:async()=>({ids:[...f.nodes.keys()],unknownKeys:['stray'],complete:true})},census:{complete:false,entries:[f.entry('a')]}});
    assert.equal(r.complete,false);assert.equal(r.candidates.length,0);
    assert.ok(r.observedUnreferenced.some(x=>x.id===orphan));assert.ok(r.issues.some(x=>x.code==='CORRUPT_FILE'));
    assert.ok(r.issues.some(x=>x.code==='UNKNOWN_FILES'));
});
test('malformed refs and missing orphan index dependencies fail closed',async()=>{
    const f=await fixture();await f.graph.save({kind:'amin-story-index',version:1,chat:'missing',order:{},messages:{},inheritedFrom:{chat:'a',indexId:'sha256:'+'f'.repeat(64)}});
    const e=f.entry('a');e.chat=[{extra:{amin_story_v2:{version:3,stateId:f.base}}}];
    const r=await scanStoryLibrary({store:f.store,census:{complete:true,entries:[e]}});
    assert.equal(r.complete,false);assert.ok(r.issues.some(x=>x.code==='MISSING_DEPENDENCY'));assert.ok(r.issues.some(x=>x.code==='INVALID_REFERENCE'));
});
test('abort rejects and concurrent file reads remain bounded',async()=>{
    const f=await fixture();let active=0,peak=0;
    const r=await scanStoryLibrary({store:{...f.store,get:async id=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,1));active--;return f.store.get(id);}},concurrency:2,census:{complete:true,entries:[]}});
    assert.equal(r.complete,true);assert.ok(peak<=2);
    const controller=new AbortController();controller.abort();await assert.rejects(scanStoryLibrary({store:f.store,census:{complete:true,entries:[]},signal:controller.signal}),{name:'AbortError'});
});
test('resource cap blocks cleanup without attempting all files',async()=>{
    const f=await fixture();const r=await scanStoryLibrary({store:f.store,maxFiles:1,census:{complete:true,entries:[]}});
    assert.equal(r.complete,false);assert.equal(r.candidates.length,0);assert.ok(r.issues.some(x=>x.code==='FILE_LIMIT'));
});
test('registered catalog completeness is not proof of global disk coverage',async()=>{
    const f=await fixture();const r=await scanStoryLibrary({store:f.store,census:{complete:true,entries:[],scope:'registered-chats-and-backups',capabilities:{globalDiskCoverage:false,maintenanceLock:false}}});
    assert.equal(r.complete,false);assert.equal(r.candidates.length,0);assert.equal(r.observedUnreferenced.length,4);
    assert.equal(r.scope,'registered-chats-and-backups');assert.ok(r.issues.some(x=>x.code==='GLOBAL_COVERAGE_UNPROVEN'));
});
test('host document bytes remain separate from extension dependency bytes',async()=>{
    const f=await fixture();const r=await scanStoryLibrary({store:f.store,census:{complete:true,entries:[{...f.entry('a'),documentBytes:9000},{...f.entry('b','backup'),documentBytes:12000}]}});
    assert.equal(r.summary.chatDocumentBytes,9000);assert.equal(r.summary.backupDocumentBytes,12000);
    assert.equal(r.chats[0].documentBytes,9000);assert.equal(r.summary.sharedBytes,r.summary.bytes);
});
