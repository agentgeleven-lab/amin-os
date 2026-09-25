import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { ROOTS } from '../apps/state2/storage.js';
import { KEY, emptyLinkageState } from '../apps/linkage/policy.js';
import { KEY as PERSON_KEY, emptyStore, appendSnapshot, readCharacters, readStore } from '../apps/characters/model.js';
import { createOperationService } from '../apps/shared/operations.js';
const person={id:'alice',name:'Alice',kind:'npc',notes:'',stats:[]};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
function fixture(options={}){
    let calls=0,saves=0,fail=false;
    const ctx={chatId:'branch',getCurrentChatId(){return this.chatId;},chat:[{is_user:true,name:'User',mes:'start'}],characterId:0,characters:[{avatar:'fixture.png'}],extensionSettings:{LittleWhiteBox:{variablesMode:'2.0'}},chatMetadata:{variables:{other:'keep'},[KEY]:{...emptyLinkageState(),enabled:true,modules:{characters:{enabled:true,read:true,write:true}}}},saveMetadata:async()=>{saves++;if(fail)throw Error('offline');},saveMetadataDebounced(){}};
    ctx.chatMetadata[PERSON_KEY]=appendSnapshot(emptyStore(),ctx.chat,{version:1,characters:[person]},{id:'initial',at:'2026-09-24T00:00:00Z'});
    const logs=[],host={LWB_StateV2:{applyText(){calls++;throw Error('must never execute AI state twice');}}};
    const runtime=createState2Runtime(()=>ctx,{host,interval:0,report:text=>logs.push(text),...options});
    return {ctx,runtime,logs,get calls(){return calls;},get saves(){return saves;},set fail(v){fail=v;}};
}
test('native runtime migrates, follows variables, and never executes model updates itself',async()=>{
    const f=fixture();try{
        await f.runtime.prepareGeneration();
        assert.equal(parse(f.ctx.chatMetadata.variables[ROOTS.characters]).characters[0].name,'Alice');
        const next=parse(f.ctx.chatMetadata.variables[ROOTS.characters]);next.characters[0].name='Native';f.ctx.chatMetadata.variables[ROOTS.characters]=JSON.stringify(next);
        assert.equal(f.runtime.sync(),true);assert.equal(readCharacters(f.ctx).characters[0].name,'Native');
        assert.equal(f.runtime.sync(),false);assert.equal(f.calls,0);assert.equal(f.ctx.chatMetadata.variables.other,'keep');
    }finally{f.runtime.destroy();}
});
test('modern manual transaction writes canonical variable and retries without a second change',async()=>{
    const f=fixture(),op=createOperationService(()=>f.ctx);try{
        await f.runtime.migrate();
        const token=op.capture([[PERSON_KEY]]),state=readCharacters(f.ctx);state.characters[0].name='Manual';
        const store=appendSnapshot(readStore(f.ctx),f.ctx.chat,state,{id:'manual',at:'2026-09-24T01:00:00Z'});
        op.stage({label:'edit',patches:[{path:[PERSON_KEY],value:store}]},token);f.fail=true;
        await assert.rejects(op.confirm(),/保存失败/);
        assert.equal(parse(f.ctx.chatMetadata.variables[ROOTS.characters]).characters[0].name,'Manual');
        const once=structuredClone(f.ctx.chatMetadata);f.fail=false;await op.retrySave();assert.deepEqual(f.ctx.chatMetadata,once);
        assert.equal(f.calls,0);
    }finally{op.dispose();f.runtime.destroy();}
});
test('native variable drift invalidates an already captured editor operation',async()=>{
    const f=fixture(),op=createOperationService(()=>f.ctx);try{
        await f.runtime.migrate();const token=op.capture([[PERSON_KEY]]);
        const native=parse(f.ctx.chatMetadata.variables[ROOTS.characters]);native.characters[0].notes='changed';f.ctx.chatMetadata.variables[ROOTS.characters]=JSON.stringify(native);
        assert.throws(()=>op.check(token),/变化|变更|过期/);
    }finally{op.dispose();f.runtime.destroy();}
});

test('empty-chat migration reports the unmet baseline instead of claiming success', async () => {
    const f = fixture();
    try {
        f.ctx.chat = [];
        await assert.rejects(f.runtime.migrate(), /发送一条消息/);
        assert.equal(f.runtime.status().migrated, false);
        assert.equal(f.saves, 0);
    } finally { f.runtime.destroy(); }
});

test('branch hydration waits for native replay instead of copying future variables', async () => {
    let finish, restores = 0;
    const f = fixture({ restoreNative: async (floor, { context }) => {
        restores++;
        assert.equal(floor, 0);
        await new Promise(resolve => { finish = resolve; });
        const ctx = context();
        ctx.chatMetadata.variables[ROOTS.characters] = ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'].vars[ROOTS.characters];
        return { restored: true, stale: false };
    } });
    const op = createOperationService(() => f.ctx);
    try {
        await f.runtime.migrate();
        f.ctx.chat.push({ is_user: false, mes: 'future' });
        const next = parse(f.ctx.chatMetadata.variables[ROOTS.characters]);
        next.characters[0].name = 'Future';
        f.ctx.chatMetadata.variables[ROOTS.characters] = JSON.stringify(next);
        f.runtime.sync();
        f.ctx.chatMetadata = structuredClone(f.ctx.chatMetadata);
        f.ctx.chatId = 'earlier-branch'; f.ctx.chat.pop();
        const pending = f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), false);
        assert.equal(f.runtime.sync(), false);
        assert.throws(() => op.capture([[PERSON_KEY]]), /尚未恢复/);
        assert.equal(parse(f.ctx.chatMetadata.variables[ROOTS.characters]).characters[0].name, 'Future');
        finish(); await pending;
        assert.equal(f.runtime.ready(), true);
        assert.equal(readCharacters(f.ctx).characters[0].name, 'Alice');
        f.runtime.sync(); f.runtime.sync();
        assert.equal(restores, 1);
        assert.equal(f.calls, 0);
    } finally { op.dispose(); f.runtime.destroy(); }
});

test('failed native replay blocks hydration and reports a recoverable error', async () => {
    const f = fixture({ restoreNative: async () => { throw Error('missing native module'); } });
    try {
        await f.runtime.migrate();
        f.ctx.chatMetadata = structuredClone(f.ctx.chatMetadata); f.ctx.chatId = 'branch';
        const before = structuredClone(f.ctx.chatMetadata);
        await f.runtime.restoreChat();
        assert.equal(f.runtime.ready(), false);
        assert.equal(f.runtime.sync(), false);
        assert.deepEqual(f.ctx.chatMetadata, before);
        assert.match(f.runtime.status().message, /missing native module/);
        f.runtime.collectReply(0); // Another diagnostic must not erase the restore failure.
        assert.equal(f.runtime.status().restoreError, 'missing native module');
        assert.equal(f.runtime.status().ready, false);
        f.ctx.chatMetadata = structuredClone(f.ctx.chatMetadata); f.ctx.chatId = 'different';
        assert.equal(f.runtime.status().restoreError, '');
    } finally { f.runtime.destroy(); }
});

test('read-free save leases do not serialize native checkpoints into their tokens', async () => {
    const f = fixture(), op = createOperationService(() => f.ctx);
    try {
        await f.runtime.migrate();
        assert.deepEqual(op.capture().paths, []);
        assert.ok(op.capture([[PERSON_KEY]]).paths.some(path => path[0] === 'extensions'));
    } finally { op.dispose(); f.runtime.destroy(); }
});


test('projecting native variables updates derived views without scheduling a host save',async()=>{
    const f=fixture();let delayed=0;f.ctx.saveMetadataDebounced=()=>{delayed++;};
    try{
        await f.runtime.prepareGeneration();
        const before=f.saves, state=parse(f.ctx.chatMetadata.variables[ROOTS.characters]);
        state.characters[0].name='Native display';
        f.ctx.chatMetadata.variables[ROOTS.characters]=JSON.stringify(state);
        assert.equal(f.runtime.sync(),true);
        assert.equal(readCharacters(f.ctx).characters[0].name,'Native display');
        assert.equal(delayed,0);assert.equal(f.saves,before);
    }finally{f.runtime.destroy();}
});


test('successful restore retry clears the saved failure reason',async()=>{
 let fail=true;
 const f=fixture({restoreNative:async()=>{if(fail)throw Error('missing file');return {restored:true,stale:false};}});
 try{
  await f.runtime.migrate();f.ctx.chatMetadata=structuredClone(f.ctx.chatMetadata);f.ctx.chatId='retry';
  await f.runtime.restoreChat();assert.equal(f.runtime.status().restoreError,'missing file');
  fail=false;await f.runtime.restoreChat();assert.equal(f.runtime.status().restoreError,'');assert.equal(f.runtime.status().ready,true);
 }finally{f.runtime.destroy();}
});
