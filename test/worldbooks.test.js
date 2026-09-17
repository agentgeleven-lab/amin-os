import test from 'node:test';
import assert from 'node:assert/strict';
import {createManager,emptyState,character} from '../apps/worldbooks/service.js';
import {createHost} from '../apps/worldbooks/host.js';
function fixture(initial){
 let ctx={characterId:0,characters:[{avatar:'a.png',name:'A'},{avatar:'b.png',name:'B'}]},globals=['baseline'],saved;
 const books={baseline:{entries:{0:{uid:0,content:'keep',disable:false}}},one:{entries:{0:{uid:0,comment:'first',content:'original',constant:true,key:['x'],disable:false},1:{uid:1,content:'second',disable:true},2:{uid:2,content:'unset'}}},two:{entries:{}}};
 const host={names:async()=>Object.keys(books),globals:()=>[...globals],load:async n=>{if(!books[n])throw Error('missing');return structuredClone(books[n]);},save:async(n,d)=>{books[n]=structuredClone(d);},setGlobal:async(n,on)=>{globals=globals.filter(x=>x!==n);if(on)globals.push(n);}};
 const api=createManager({host,context:()=>ctx,initial:initial??emptyState(),persist:s=>{saved=s;}});
 return {api,host,books,ctx,get saved(){return saved;}};
}
const profile=(books=['one'],entries={})=>({books,entries});
test('only missing global books are owned; unrelated and preexisting globals survive',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['baseline','one']));assert.deepEqual(f.api.snapshot().session.books,['one']);
 await f.host.setGlobal('two',true);f.ctx.characterId=1;await f.api.sync();assert.deepEqual(f.host.globals(),['baseline','two']);
});
test('entry overrides restore exact original flags and preserve all other fields',async()=>{
 const f=fixture(),original=structuredClone(f.books.one);await f.api.apply('a.png',profile(['one'],{one:{0:'off',1:'on',2:'off'}}));
 assert.equal(f.books.one.entries[0].disable,true);assert.equal(f.books.one.entries[1].disable,false);
 f.books.one.entries[0].content='external edited prose';f.ctx.characterId=1;await f.api.sync();original.entries[0].content='external edited prose';assert.deepEqual(f.books.one,original);
});
test('same character chat change does not override manually disabled global book',async()=>{
 const f=fixture();await f.api.apply('a.png',profile());await f.host.setGlobal('one',false);await f.api.sync();assert(!f.host.globals().includes('one'));
 await f.api.sync(true);assert(f.host.globals().includes('one'));
});
test('external entry flag change is preserved on exit',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['one'],{one:{2:'off'}}));f.books.one.entries[2].disable=false;f.ctx.characterId=1;await f.api.sync();assert.equal(f.books.one.entries[2].disable,false);assert(f.api.messages().some(m=>m.includes('外部修改')));
});
test('saved combinations follow each avatar across conversations',async()=>{
 const f=fixture();await f.api.apply('a.png',profile());f.ctx.characterId=1;await f.api.sync();await f.api.apply('b.png',profile(['two']));f.ctx.characterId=0;await f.api.sync();assert.deepEqual(f.host.globals(),['baseline','one']);
});
test('profile delta removes only removed books and entries',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['one','two'],{one:{0:'off',1:'on'}}));await f.api.apply('a.png',profile(['one'],{one:{1:'on'}}));assert.equal(f.books.one.entries[0].disable,false);assert.equal(f.books.one.entries[1].disable,false);assert(!f.host.globals().includes('two'));
});
test('pause stops application but still cleans old role',async()=>{
 const f=fixture();await f.api.apply('a.png',profile());await f.api.pause(true);f.ctx.characterId=1;await f.api.sync();assert.deepEqual(f.host.globals(),['baseline']);await f.api.apply('b.png',profile(['two']));assert(!f.host.globals().includes('two'));await f.api.pause(false);assert(f.host.globals().includes('two'));
});
test('group and no-character contexts have no combination',async()=>{
 const f=fixture();await f.api.apply('a.png',profile());f.ctx.groupId=0;await f.api.sync();assert.equal(character(f.ctx),null);assert.deepEqual(f.host.globals(),['baseline']);f.ctx.groupId=null;f.ctx.characterId=undefined;await f.api.sync();assert.equal(character(f.ctx),null);
});
test('manual keep releases book and entry ownership',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['one'],{one:{0:'off'}}));await f.api.keepBook('one');await f.api.keepEntry('one','0');f.ctx.characterId=1;await f.api.sync();assert(f.host.globals().includes('one'));assert.equal(f.books.one.entries[0].disable,true);
});
test('persisted journal restores after reload into another character',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['one'],{one:{2:'off'}}));f.ctx.characterId=1;const api=createManager({host:f.host,context:()=>f.ctx,initial:f.saved,persist:()=>{}});await api.sync();assert.deepEqual(f.host.globals(),['baseline']);assert(!Object.hasOwn(f.books.one.entries[2],'disable'));
});
test('reload on same role preserves manual global disable',async()=>{
 const f=fixture();await f.api.apply('a.png',profile());await f.host.setGlobal('one',false);const api=createManager({host:f.host,context:()=>f.ctx,initial:f.saved,persist:()=>{}});await api.sync();assert(!f.host.globals().includes('one'));
});
test('temporary combination is not saved as character profile',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(),false);assert(!f.api.snapshot().profiles['a.png']);f.ctx.characterId=1;await f.api.sync();f.ctx.characterId=0;await f.api.sync();assert.deepEqual(f.host.globals(),['baseline']);
});
test('display filter has no activation side effects',async()=>{
 const f=fixture();await f.api.setVisible(['one']);assert.deepEqual(f.host.globals(),['baseline']);assert.deepEqual(f.api.snapshot().visible,['one']);
});
test('missing books and deleted entries are reported without guessing replacements',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['gone','one'],{one:{99:'off',0:'off'}}));assert(f.api.messages().some(m=>m.includes('gone')));delete f.books.one;f.ctx.characterId=1;await f.api.sync();assert.equal(f.api.snapshot().session.entries.length,0);assert.deepEqual(f.host.globals(),['baseline']);
});
test('failed save retains rollback journal; failed restoration prevents applying next role',async()=>{
 const f=fixture();f.host.save=async()=>{throw Error('offline');};await assert.rejects(f.api.apply('a.png',profile(['one'],{one:{0:'off'}})),/offline/);assert.equal(f.api.snapshot().session.entries.length,1);
 // Simulate request accepted remotely before transport failure.
 f.books.one.entries[0].disable=true;f.ctx.characterId=1;await assert.rejects(f.api.sync(),/offline/);assert.equal(f.api.snapshot().session.role,'a.png');assert.equal(f.api.snapshot().session.entries.length,1);
});
test('switch during awaited read does not apply stale entry and cleans old globals',async()=>{
 const f=fixture(),load=f.host.load;f.host.load=async n=>{f.ctx.characterId=1;return load(n);};await assert.rejects(f.api.apply('a.png',profile(['one'],{one:{0:'off'}})),/角色已切换/);await f.api.sync();assert.equal(f.books.one.entries[0].disable,false);assert.deepEqual(f.host.globals(),['baseline']);
});
test('stale UI cannot save combo to a different role',async()=>{
 const f=fixture();f.ctx.characterId=1;await assert.rejects(f.api.apply('a.png',profile()),/角色已切换/);assert.deepEqual(f.api.snapshot().profiles,{});
});
test('withdraw restores owned changes and pauses automatic reapplication',async()=>{
 const f=fixture();await f.api.apply('a.png',profile(['one'],{one:{0:'off'}}));await f.api.withdraw();await f.api.sync();assert.equal(f.books.one.entries[0].disable,false);assert.deepEqual(f.host.globals(),['baseline']);assert(f.api.snapshot().paused);
});
test('host global selection preserves unrelated settings',async()=>{
 const wi={selected_world_info:['old'],world_names:['old','new'],world_info:{charLore:[{name:'x'}]},updateWorldInfoSettings(s,n){assert.deepEqual(s,{});this.selected_world_info=n;}};const h=createHost(wi,()=>({saveSettingsDebounced(){}}));await h.setGlobal('new',true);await h.setGlobal('new',false);assert.deepEqual(wi.selected_world_info,['old']);assert.deepEqual(wi.world_info.charLore,[{name:'x'}]);
});
test('host HTTP failure does not update cache or emit success',async()=>{
 let cached=false,emitted=false;const h=createHost({worldInfoCache:{set(){cached=true;}}},()=>({getRequestHeaders:()=>({}),eventTypes:{WORLDINFO_UPDATED:'updated'},eventSource:{emit(){emitted=true;}}}),{request:async()=>({ok:false,status:500})});await assert.rejects(h.save('one',{entries:{}}),/500/);assert.equal(cached,false);assert.equal(emitted,false);
});
test('host rejects a concurrent cache edit before writing the worldbook',async()=>{
 let data={entries:{0:{disable:false,content:'original'}}},writes=0;
 const wi={loadWorldInfo:async()=>data,worldInfoCache:{get:()=>data,set:v=>{data=v;}}};
 const host=createHost(wi,()=>({getRequestHeaders:()=>({})}),{request:async()=>{writes++;return {ok:true};}});
 const draft=await host.load('one');data.entries[0].content='external';draft.entries[0].disable=true;
 await assert.rejects(host.save('one',draft),/同时被其他操作修改/);assert.equal(writes,0);assert.equal(data.entries[0].content,'external');
});
test('queued save captures the profile at click time',async()=>{
 const f=fixture(),draft=profile();const saving=f.api.apply('a.png',draft);draft.books.push('two');await saving;assert.deepEqual(f.api.profile().books,['one']);
});
