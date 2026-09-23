import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkageService } from '../apps/linkage/service.js';
import { emptyLinkageState, KEY } from '../apps/linkage/policy.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';

const person = {module:'characters',action:'create-character',target:'alice',data:{name:'艾琳',kind:'pc',stats:[]},reason:'角色设定'};
const item = {module:'inventory',action:'create-item',target:'potion',data:{name:'药剂',ownerId:'alice',quantity:2,equipped:false,notes:''},reason:'初始装备设定'};
function fixture(scope, adapters=[characters,inventory]) {
    let saved=0, fail=false;
    const ctx={chat:[],characterId:0,getCurrentChatId:()=> 'setup-chat',chatMetadata:{[KEY]:{...emptyLinkageState(),extraRules:'用户原规则'},protected:'keep'},saveMetadata:async()=>{saved++;if(fail)throw Error('offline');}};
    const api=createLinkageService(()=>ctx,{adapters,manualModules:scope});
    return {ctx,api,get saved(){return saved;},set fail(value){fail=value;}};
}
test('manual initialization works in empty chat without enabling background updates or changing permissions',async()=>{
    const f=fixture(['characters','inventory']), original=structuredClone(f.ctx.chatMetadata);
    f.api.stage({version:1,changes:[person,item]});assert.deepEqual(f.ctx.chatMetadata,original);
    await f.api.confirm();assert.equal(f.saved,1);assert.equal(inventory.read(f.ctx).items[0].ownerId,'alice');
    assert.equal(f.ctx.chatMetadata[KEY].enabled,false);assert.deepEqual(f.ctx.chatMetadata[KEY].modules,{});
    assert.equal(f.ctx.chatMetadata[KEY].extraRules,'用户原规则');assert.equal(f.ctx.chatMetadata.protected,'keep');
    assert.equal(f.api.captureGeneration('normal'),false);await assert.rejects(f.api.saveSettings({...emptyLinkageState(),enabled:true}),/不能修改/);f.api.dispose();
});
test('manual scope is fixed and cannot write unchecked apps or adapter side effects',()=>{
    const scope=['characters'],f=fixture(scope);scope.push('inventory');
    assert.throws(()=>f.api.stage({version:1,changes:[person,item]}),/更新范围/);assert.equal(f.saved,0);assert.equal(characters.read(f.ctx).characters.length,0);f.api.dispose();
    const fake={...characters,apply:()=>({patches:[{path:['variables','状态栏'],value:'{}'}],summary:'invalid'})};
    const bad=fixture(['characters'],[fake]);assert.throws(()=>bad.api.stage({version:1,changes:[person]}),/没有修改/);assert.equal(bad.ctx.chatMetadata.variables,undefined);bad.api.dispose();
    assert.throws(()=>fixture(['status']),/范围无效/);assert.throws(()=>fixture([]),/范围无效/);
});
test('manual generation uses shared stale and persistence guards without duplicate apply on retry',async()=>{
    const f=fixture(['characters']);f.api.stage({version:1,changes:[person]});f.ctx.chat.push({mes:'新消息',is_user:true});
    await assert.rejects(f.api.confirm(),/已变化/);assert.equal(f.saved,0);f.api.discard();
    f.api.stage({version:1,changes:[person]});f.fail=true;await assert.rejects(f.api.confirm(),/保存失败/);
    assert.equal(f.api.dirty(),true);f.fail=false;await f.api.retrySave();
    assert.equal(characters.read(f.ctx).characters.length,1);assert.equal(f.ctx.chatMetadata[KEY].applied.length,1);assert.equal(f.saved,2);f.api.dispose();
});
