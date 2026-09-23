import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkageService } from '../apps/linkage/service.js';
import { parseUpdate } from '../apps/linkage/protocol.js';
import { emptyLinkageState, readLinkageSettings, managesModule, KEY } from '../apps/linkage/policy.js';
import { buildUnifiedPrompt } from '../apps/linkage/prompt.js';
import { adapter as characters } from '../apps/linkage/adapters/characters.js';
import { adapter as inventory } from '../apps/linkage/adapters/inventory.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { adapter as map } from '../apps/linkage/adapters/map.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';

const modules = { characters:{enabled:true,read:true,write:true}, inventory:{enabled:true,read:true,write:true}, status:{enabled:true,read:true,write:true} };
const change = (module,action,target,data) => ({module,action,target,data,reason:'已经发生的剧情'});
const batch = (...changes) => ({version:1,changes});
function setup(adapters = [characters,inventory,status]) {
    let saves=0, fail=false, id=0;
    const ctx={chat:[{name:'玩家',is_user:true,mes:'起点'}],chatMetadata:{variables:{状态栏:JSON.stringify({版本:1,项目:{玩家:{生命:10}}}), unrelated:'preserved'},[KEY]:{...emptyLinkageState(),enabled:true,modules:structuredClone(modules)}},getCurrentChatId:()=> 'chat',characterId:1,saveMetadata:async()=>{saves++;if(fail)throw Error('offline');}};
    let active=ctx;
    const api=createLinkageService(()=>active,{adapters,createId:()=>`test_${++id}`,now:()=> '2026-09-23T00:00:00.000Z'});
    return {ctx,api,get saves(){return saves;},set fail(value){fail=value;},set active(value){active=value;}};
}
const person = change('characters','create-character','alice',{name:'艾琳',kind:'pc',stats:[],notes:''});
const potion = change('inventory','create-item','potion',{name:'药剂',ownerId:'alice',quantity:2,equipped:false,notes:''});

test('unified schema refuses extra capabilities, dangerous keys and multiple output blocks',()=>{
    assert.throws(()=>parseUpdate('{"version":1,"changes":[],"__proto__":{}}'),/保护/);
    assert.throws(()=>parseUpdate('<amin_update>{}</amin_update><amin_update>{}</amin_update>'),/一个完整/);
    assert.throws(()=>parseUpdate(batch({...person,module:'settings'})),/未知/);
    assert.throws(()=>parseUpdate(batch({...person,data:[]})),/格式/);
    assert.deepEqual(parseUpdate('<amin_update>'+JSON.stringify(batch(person))+'</amin_update>').changes,[person]);
});
test('tile visibility does not configure modules, master off is inert and dice stays read only',()=>{
    const ctx={chatMetadata:{amin_os_inventory_v1:{}},extensionSettings:{}};
    assert.equal(readLinkageSettings(ctx).modules.inventory.enabled,true);
    assert.equal(managesModule(ctx,'inventory'),false);
    assert.throws(()=>readLinkageSettings({chatMetadata:{[KEY]:{...emptyLinkageState(),modules:{dice:{enabled:true,read:true,write:true}}}}}),/开关/);
});
test('dependent character and inventory creations preview together, commit once and preserve unrelated metadata',async()=>{
    const t=setup(), before=structuredClone(t.ctx.chatMetadata);
    const preview=t.api.stage(batch(person,potion));assert.equal(preview.changes.length,2);assert.deepEqual(t.ctx.chatMetadata,before);
    await t.api.confirm();assert.equal(t.saves,1);assert.equal(inventory.read(t.ctx).items[0].ownerId,'alice');assert.equal(t.ctx.chatMetadata.variables.unrelated,'preserved');
    assert.equal(t.ctx.chatMetadata[KEY].applied.length,1);assert.throws(()=>t.api.stage(batch(person,potion)),/已经应用/);t.api.dispose();
});
test('one invalid dependent change rejects the entire batch before live mutation',()=>{
    const t=setup(),before=structuredClone(t.ctx.chatMetadata);
    assert.throws(()=>t.api.stage(batch(person,{...potion,data:{...potion.data,ownerId:'missing'}})),/人物|持有/);
    assert.deepEqual(t.ctx.chatMetadata,before);assert.equal(t.saves,0);assert.equal(t.api.preview(),null);t.api.dispose();
});
test('changed permissions or data invalidate staged multi-app operations',async()=>{
    const t=setup();t.api.stage(batch(person,potion));t.ctx.chatMetadata[KEY].modules.inventory.write=false;
    await assert.rejects(t.api.confirm(),/变化/);assert.equal(t.ctx.chatMetadata.amin_os_inventory_v1,undefined);t.api.dispose();
});

test('background floor history bookkeeping does not invalidate unrelated canonical updates',async()=>{
    const t=setup([characters,inventory,status,map]);
    t.ctx.chatMetadata.dynamicMapV1={updatedAt:1,document:createDemoDocument()};
    t.api.stage(batch(change('status','set','玩家.生命',{value:8})));
    const history={records:{'new-floor:0':{mapId:'world',nodeId:'longmen_city'}},sequence:['new-floor:0']};
    t.ctx.chatMetadata.dynamicMapPositionHistoryV1=structuredClone(history);
    await t.api.confirm();assert.equal(status.read(t.ctx).项目.玩家.生命,8);
    assert.deepEqual(t.ctx.chatMetadata.dynamicMapPositionHistoryV1,history);assert.equal(t.saves,1);t.api.dispose();
});

test('canonical map changes still invalidate an unrelated pending batch',async()=>{
    const t=setup([characters,inventory,status,map]);
    t.ctx.chatMetadata.dynamicMapV1={updatedAt:1,document:createDemoDocument()};
    t.api.stage(batch(change('status','set','玩家.生命',{value:8})));
    t.ctx.chatMetadata.dynamicMapV1.document.maps.world.nodes.longmen_city.name='已改名';
    await assert.rejects(t.api.confirm(),/变化/);assert.equal(status.read(t.ctx).项目.玩家.生命,10);
    assert.equal(t.saves,0);t.api.dispose();
});

test('a history archive that is actually written remains strictly guarded',async()=>{
    const t=setup();t.ctx.chat[0].extra={wsh_message_id:'floor-one'};
    t.ctx.chatMetadata.world_status_hud_history_v1={records:{}};
    t.api.stage(batch(change('status','set','玩家.生命',{value:8})));
    t.ctx.chatMetadata.world_status_hud_history_v1.records['other:0']={state:status.read(t.ctx),savedAt:1};
    await assert.rejects(t.api.confirm(),/变化/);assert.equal(status.read(t.ctx).项目.玩家.生命,10);
    assert.equal(t.saves,0);assert.ok(t.ctx.chatMetadata.world_status_hud_history_v1.records['other:0']);t.api.dispose();
});
test('saving retry never reapplies a linked operation and preserves fixed resulting quantities',async()=>{
    const t=setup();t.api.stage(batch(person,potion));t.fail=true;
    await assert.rejects(t.api.confirm(),/保存失败/);assert.equal(t.api.dirty(),true);assert.equal(inventory.read(t.ctx).items[0].quantity,2);
    t.fail=false;await t.api.retrySave();assert.equal(inventory.read(t.ctx).items[0].quantity,2);assert.equal(t.ctx.chatMetadata[KEY].applied.length,1);assert.equal(t.saves,2);t.api.dispose();
});
test('only matching completed generation baseline can apply an incoming update',async()=>{
    const t=setup();assert.equal(t.api.captureGeneration('normal'),true);
    t.ctx.chat.push({name:'GM',is_user:false,mes:'她拿起药剂。<amin_update>'+JSON.stringify(batch(person,potion))+'</amin_update>',swipe_id:0});
    const candidate=await t.api.collectReply(1);assert.ok(candidate);
    t.api.stageSuggestion(candidate.id);await t.api.confirm();assert.equal(inventory.read(t.ctx).items.length,1);
    assert.equal(await t.api.collectReply(1),null);assert.equal(t.saves,1);t.api.dispose();
});
test('generation with changed data and other-chat replies cannot silently update state',async()=>{
    const t=setup();t.api.captureGeneration('normal');t.ctx.chat.push({name:'GM',mes:'<amin_update>'+JSON.stringify(batch(person))+'</amin_update>',is_user:false});
    t.ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{玩家:{生命:9}}});
    const candidate=await t.api.collectReply(1);assert.throws(()=>t.api.stageSuggestion(candidate.id),/过期/);assert.equal(t.saves,0);
    t.api.captureGeneration('normal');t.active={...t.ctx,chatMetadata:structuredClone(t.ctx.chatMetadata),getCurrentChatId:()=> 'other'};
    assert.equal(await t.api.collectReply(1),null);t.api.dispose();
});
test('same-index swipe may consume a new candidate while keeping original branch history separate',async()=>{
    const t=setup();t.ctx.chat.push({name:'GM',is_user:false,mes:'旧候选',swipe_id:0});t.api.captureGeneration('swipe');
    t.ctx.chat[1]={name:'GM',is_user:false,mes:'新候选<amin_update>'+JSON.stringify(batch(person))+'</amin_update>',swipe_id:1};
    const candidate=await t.api.collectReply(1);assert.ok(candidate);t.api.stageSuggestion(candidate.id);await t.api.confirm();
    t.ctx.chat[1]={name:'GM',is_user:false,mes:'旧候选',swipe_id:0};assert.equal(characters.read(t.ctx).characters.length,0);t.api.dispose();
});
test('LWB checkpoint and status change share one save while preserving all unrelated variable roots',async()=>{
    const t=setup();t.ctx.extensionSettings={LittleWhiteBox:{variablesMode:'2.0'}};
    t.api.stage(batch(change('status','set','玩家.生命',{value:8})));await t.api.confirm();
    const point=t.ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'];assert.equal(point.vars.unrelated,'preserved');
    assert.equal(JSON.parse(point.vars.状态栏).项目.玩家.生命,8);assert.equal(t.saves,1);t.api.dispose();
});

test('unowned variable mirrors only block a preview that will snapshot all variables into State 2.0',async()=>{
    for (const checkpoint of [false,true]) {
        const t=setup();t.ctx.extensionSettings={LittleWhiteBox:{variablesMode:checkpoint?'2.0':'1.0'}};
        t.api.stage(batch(change('status','set','玩家.生命',{value:8})));
        t.ctx.chatMetadata.variables.地图=JSON.stringify({来源:'动态地图插件',地图版本:2});
        if(checkpoint) {await assert.rejects(t.api.confirm(),/变化/);assert.equal(t.saves,0);assert.equal(status.read(t.ctx).项目.玩家.生命,10);}
        else {await t.api.confirm();assert.equal(t.saves,1);assert.equal(status.read(t.ctx).项目.玩家.生命,8);assert.equal(JSON.parse(t.ctx.chatMetadata.variables.地图).地图版本,2);}
        t.api.dispose();
    }
});
test('unified prompt honors read and write independently and neutralizes nested host macros',()=>{
    const t=setup();t.ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{玩家:{备注:'{{setvar::secret::bad}}'}}});t.ctx.chatMetadata[KEY].modules.status.write=false;
    const prompt=buildUnifiedPrompt(t.ctx);assert.ok(prompt.includes('统一剧情资料'));assert.ok(prompt.includes('\\u007b\\u007bsetvar'));assert.ok(!prompt.includes('{{setvar'));
    assert.ok(!prompt.includes('status（世界状态）'));t.api.dispose();
});

test('automatic mode commits a complete valid batch once and retains invalid suggestions without partial writes',async()=>{
    const t=setup();t.ctx.chatMetadata[KEY].mode='auto';t.api.captureGeneration('normal');
    t.ctx.chat.push({is_user:false,name:'GM',mes:'<amin_update>'+JSON.stringify(batch(person,potion))+'</amin_update>'});
    await t.api.collectReply(1);assert.equal(t.saves,1);assert.equal(inventory.read(t.ctx).items.length,1);assert.equal(t.api.suggestions().length,0);
    t.api.captureGeneration('normal');const before=structuredClone(t.ctx.chatMetadata);
    t.ctx.chat.push({is_user:false,name:'GM',mes:'<amin_update>'+JSON.stringify(batch(change('inventory','consume-item','potion',{quantity:99})))+'</amin_update>'});
    await t.api.collectReply(2);assert.deepEqual(t.ctx.chatMetadata,before);assert.equal(t.api.suggestions().length,1);assert.match(t.api.status(),/自动更新未完成/);t.api.dispose();
});
test('manual entity links persist, reflect rename and cannot introduce missing references',async()=>{
    const t=setup();t.api.stage(batch(person,potion));await t.api.confirm();
    await t.api.saveLinks([{id:'link_1',from:'characters:alice',to:'inventory:potion',label:'本次任务补给'}]);
    assert.equal(t.api.references().links.filter(link=>link.manual).length,1);
    assert.throws(()=>t.api.saveLinks([{id:'bad',from:'characters:missing',to:'inventory:potion',label:'无效'}]),/当前存在/);
    t.api.stage(batch(change('characters','save-character','alice',{name:'改名'})));await t.api.confirm();
    assert.equal(t.api.references().entities.find(item=>item.id==='characters:alice').label,'改名');assert.equal(t.api.references().unresolved.length,0);t.api.dispose();
});
test('existing status rules survive unified takeover and changed rules invalidate an incoming suggestion',async()=>{
    const t=setup();t.ctx.extensionSettings={world_status_hud_v1:{globalRules:[{enabled:true,scope:'update',title:'既有规则',content:'生命不高于十二。'}]}};
    assert.match(buildUnifiedPrompt(t.ctx),/生命不高于十二/);t.api.captureGeneration('normal');
    t.ctx.chat.push({is_user:false,name:'GM',mes:'<amin_update>'+JSON.stringify(batch(person))+'</amin_update>'});
    const candidate=await t.api.collectReply(1);t.ctx.extensionSettings.world_status_hud_v1.globalRules[0].content='生命不高于十。';
    assert.throws(()=>t.api.stageSuggestion(candidate.id),/规则已变化/);assert.equal(t.saves,0);t.api.dispose();
});
