import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryLibraryFileStore } from '../apps/shared/story-library-files.js';
import { createStoryLibraryService } from '../apps/shared/story-library-service.js';
import { sha256Hex } from '../apps/tts/source-hash.js';

test('library transport enumerates only Amin story table and preserves unknown names as a blocker',async()=>{
 const calls=[],id='a'.repeat(64);const api={listKeys:async options=>{calls.push(options);return ['h-'+id,'k-old_1','other.json'];},tryGetJson:async options=>{calls.push(options);return {found:true,value:{example:1}};},setJson:()=>{throw Error('write forbidden');}};
 const store=createStoryLibraryFileStore({getHostWindow:()=>({__TAURITAVERN__:{api:{extension:{store:api}}}})});
 assert.deepEqual(await store.list(),{ids:['old_1','sha256:'+id],unknownKeys:['other.json'],complete:false});
 assert.deepEqual(await store.get('sha256:'+id),{example:1});
 assert.ok(calls.every(c=>c.namespace==='amin-os'&&c.table==='story-v2'));assert.equal('delete' in store,false);
});
async function fixture(){
 const value={kind:'snapshot',value:1},fingerprint=await sha256Hex(JSON.stringify(value));let stamp='first',reads=0;
 const row={id:'sha256:'+'a'.repeat(64),bytes:40,fingerprint};
 const service=createStoryLibraryService({hostAdapter:{census(){},capabilities:()=>({maintenanceLock:false,globalDiskCoverage:false,scope:'registered',reason:'no global lock'})},store:{async get(){reads++;return structuredClone(value);}},scan:async()=>({fingerprint:stamp,complete:false,observedUnreferenced:[row],candidates:[],cleanupBlockedReason:'partial'})});
 return {service,value,reads:()=>reads,change:()=>stamp='second'};
}
test('candidate backup is read only and allowed for observed files without claiming deletion safety',async()=>{
 const f=await fixture(),report=await f.service.scan();assert.equal(report.deletionAuthorized,false);assert.match(report.cleanupBlockedReason,/no global lock/);
 const bundle=await f.service.exportCandidates(report);assert.equal(Object.keys(bundle.records).length,1);assert.equal(bundle.complete,false);assert.equal(f.reads(),1);assert.equal('delete' in f.service,false);f.service.dispose();
});
test('backup rechecks scan and rejects changed content, stale reports, cancellation and disposal',async()=>{
 const f=await fixture();await assert.rejects(f.service.exportCandidates({fingerprint:'x'}),/先/);const report=await f.service.scan();f.change();await assert.rejects(f.service.exportCandidates(report),/变化/);assert.equal(f.reads(),0);f.service.dispose();await assert.rejects(f.service.scan(),/关闭/);
 const g=await fixture(),second=await g.service.scan();g.value.value=2;await assert.rejects(g.service.exportCandidates(second),/内容已变化/);const ctrl=new AbortController();ctrl.abort();await assert.rejects(g.service.scan({signal:ctrl.signal}),/取消/);g.service.dispose();
});
