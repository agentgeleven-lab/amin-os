import test from 'node:test';
import assert from 'node:assert/strict';
import { createState2Runtime } from '../apps/state2/runtime.js';
import { ROOTS } from '../apps/state2/storage.js';
import { KEY, emptyLinkageState } from '../apps/linkage/policy.js';
import { KEY as PERSON_KEY, emptyStore, appendSnapshot, readCharacters, readStore } from '../apps/characters/model.js';
import { createOperationService } from '../apps/shared/operations.js';
const person={id:'alice',name:'Alice',kind:'npc',notes:'',stats:[]};
const parse=v=>typeof v==='string'?JSON.parse(v):v;
function fixture(){
    let calls=0,saves=0,fail=false;
    const ctx={chatId:'branch',getCurrentChatId(){return this.chatId;},chat:[{is_user:true,name:'User',mes:'start'}],characterId:0,characters:[{avatar:'fixture.png'}],extensionSettings:{LittleWhiteBox:{variablesMode:'2.0'}},chatMetadata:{variables:{other:'keep'},[KEY]:{...emptyLinkageState(),enabled:true,modules:{characters:{enabled:true,read:true,write:true}}}},saveMetadata:async()=>{saves++;if(fail)throw Error('offline');},saveMetadataDebounced(){}};
    ctx.chatMetadata[PERSON_KEY]=appendSnapshot(emptyStore(),ctx.chat,{version:1,characters:[person]},{id:'initial',at:'2026-09-24T00:00:00Z'});
    const logs=[],host={LWB_StateV2:{applyText(){calls++;throw Error('must never execute AI state twice');}}};
    const runtime=createState2Runtime(()=>ctx,{host,interval:0,report:text=>logs.push(text)});
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
