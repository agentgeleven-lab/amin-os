import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationService } from '../apps/generation/service.js';
import { collectGenerationSources } from '../apps/generation/sources.js';
import { createLinkageService } from '../apps/linkage/service.js';
import { adapter as status } from '../apps/linkage/adapters/status.js';
import { emptyLinkageState, KEY } from '../apps/linkage/policy.js';
import { STATE_KEY, emptyState } from '../apps/story-state/schema.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';

const state = () => ({版本:1,项目:{玩家:{生命:10,描述:'平静',存活:true,装备:['剑'],体力:{当前:8,最大:10}},世界:{地点:'城外'}}});
const set = (target, value, extra = {}) => ({module:'status',action:'set',target,data:{value,...extra},reason:'第2楼明确描述的新事实'});
const request = {modules:['status'],mode:'update',sources:{includeChat:true,start:1,end:1}};
function fixture({independent=false,master=true,mode='review',changes=[set('玩家.生命',9)]}={}) {
    let saves=0, fail=false, callback, sourceCallback, output=changes;
    const ctx={characterId:0,characters:[{avatar:'hero.png',name:'主角'}],getCurrentChatId:()=> 'status-generation',extensionSettings:{},
        chat:[{is_user:true,mes:'不在选择范围的旧剧情',swipe_id:0},{is_user:false,mes:'主角受伤，生命降到9，抵达城门。',swipe_id:0,extra:{wsh_message_id:'floor-2'}}],
        chatMetadata:{variables:{状态栏:JSON.stringify(state()),Foreign:'keep'},protected:'keep',[KEY]:{...emptyLinkageState(),enabled:master,mode,modules:{status:{enabled:true,read:true,write:true}}}},
        async saveMetadata(){saves++;if(fail)throw Error('offline');}};
    if(independent)ctx.chatMetadata[STATE_KEY]={...emptyState(),modules:{...emptyState().modules,status:state()}};
    const runtime=independent?createStoryStateRuntime(()=>ctx,{backups:{available:()=>false,status:()=>({available:false}),savePrevious:async()=>{}}}):null;
    const calls=[],captures=[];
    const api=createGenerationService(()=>ctx,{ai:{capture(route){captures.push(route);return {route,channel:'status-channel'};},async generate(...args){calls.push(args);await callback?.();return JSON.stringify({version:1,changes:output});}},
        collectSources:async(...args)=>{await sourceCallback?.();return collectGenerationSources(...args);}});
    return {ctx,api,calls,captures,get saves(){return saves;},set fail(value){fail=value;},set callback(value){callback=value;},set sourceCallback(value){sourceCallback=value;},set changes(value){output=value;},dispose(){api.dispose();runtime?.destroy();}};
}

for(const independent of [false,true])for(const mode of ['off','review','auto'])test(`status ${independent?'independent':'legacy'} / ${mode} drafts and previews without writing, confirms exactly once`,async()=>{
    const f=fixture({independent,master:mode!=='off',mode:mode==='off'?'review':mode});
    try {
        const before=structuredClone(f.ctx.chatMetadata),chat=structuredClone(f.ctx.chat);
        const draft=await f.api.generate(request);assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);
        assert.deepEqual(f.captures,['status']);assert.equal(f.calls[0][3].snapshot.channel,'status-channel');
        const payload=f.calls[0][2],prompt=JSON.parse(payload.prompt),sources=JSON.parse(prompt.sources);
        assert.deepEqual(prompt.modules,['status']);assert.deepEqual(prompt.references,{});assert.equal(prompt.existing.status.项目.玩家.生命,10);
        assert.deepEqual(sources.chat.map(row=>row.index),[1]);assert.doesNotMatch(prompt.sources,/不在选择范围/);
        assert.match(payload.systemPrompt,/绝对值/);assert.doesNotMatch(payload.systemPrompt,/adjust:|create-character|stats=\[\]/);
        for(const flag of ['includeLinkage','includeEffects','includeJournal','includeScene'])assert.equal(f.calls[0][3][flag],false);
        const preview=f.api.stage(draft.changes);assert.match(preview.summary[0],/10 → 9/);assert.equal(preview.changes[0].reason,draft.changes[0].reason);
        assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);
        await f.api.confirm();assert.equal(status.read(f.ctx).项目.玩家.生命,9);assert.equal(f.saves,1);assert.deepEqual(f.ctx.chat,chat);
        assert.equal(f.ctx.chatMetadata[KEY].enabled,before[KEY].enabled);assert.equal(f.ctx.chatMetadata[KEY].mode,before[KEY].mode);assert.deepEqual(f.ctx.chatMetadata[KEY].modules,before[KEY].modules);
        assert.equal(f.ctx.chatMetadata[KEY].applied.length,1);assert.equal(f.ctx.chatMetadata.protected,'keep');
        if(independent){assert.deepEqual(f.ctx.chatMetadata.variables,before.variables);assert.equal(f.ctx.chatMetadata[STATE_KEY].revision,1);assert.equal(f.ctx.chatMetadata.world_status_hud_history_v1,undefined);}
        await assert.rejects(f.api.confirm(),/先预览/);assert.equal(f.saves,1);
    }finally{f.dispose();}
});

test('status preserves every supported field type and progress component, with editable selected proposals',async()=>{
    const f=fixture({changes:[set('玩家.生命',9),set('玩家.描述','疲惫'),set('玩家.存活',false),set('玩家.装备',['剑','盾']),set('玩家.体力',12,{component:'max'}),set('玩家.体力',7,{component:'current'}),set('世界.地点','城门')]});
    try {const draft=await f.api.generate(request);const selected=draft.changes.slice(0,-1);selected[0].data.value=8;
        f.api.stage(selected);await f.api.confirm();assert.deepEqual(status.read(f.ctx).项目.玩家,{生命:8,描述:'疲惫',存活:false,装备:['剑','盾'],体力:{当前:7,最大:12}});assert.equal(status.read(f.ctx).项目.世界.地点,'城外');
    }finally{f.dispose();}
});

for(const invalid of [set('玩家.不存在',1),set('玩家.生命','9'),set('玩家.体力',{当前:11,最大:10}),set('玩家.装备',[1]),set('玩家.生命',null),set('玩家.生命',9,{component:'current'}),{...set('玩家.生命',9),action:'adjust',data:{delta:-1}},{...set('玩家.生命',9),action:'delete'},{...set('玩家.生命',9),reason:''}])test('invalid status proposal fails the entire batch: '+JSON.stringify(invalid),async()=>{
    const f=fixture({changes:[set('世界.地点','城门'),invalid]});try{const before=structuredClone(f.ctx.chatMetadata);await assert.rejects(f.api.generate(request));assert.equal(f.api.draft(),null);assert.equal(f.saves,0);assert.deepEqual(f.ctx.chatMetadata,before);}finally{f.dispose();}
});

test('status cannot create, supplement, mix modules, omit floors or invent an empty schema',async()=>{
    const f=fixture();try{for(const options of [{mode:'create'},{mode:'supplement'},{modules:['status','characters']},{sources:{},instruction:'更新状态'},{sources:{includeChat:true,start:8,end:9}}])await assert.rejects(f.api.generate({...request,...options}));
        f.ctx.chatMetadata.variables.状态栏=JSON.stringify({版本:1,项目:{}});await assert.rejects(f.api.generate(request),/没有可更新/);assert.equal(f.calls.length,0);assert.equal(f.saves,0);
    }finally{f.dispose();}
});

for(const permission of [{enabled:false,read:true,write:true},{enabled:true,read:false,write:false},{enabled:true,read:true,write:false}])test('manual status respects disabled permissions even with master off '+JSON.stringify(permission),async()=>{
    const f=fixture({master:false});try{f.ctx.chatMetadata[KEY].modules.status=permission;await assert.rejects(f.api.generate(request),/允许模型更新/);assert.equal(f.calls.length,0);assert.equal(f.saves,0);}finally{f.dispose();}
});

for(const stage of ['generate','stage','confirm'])test('status permission changes fail closed at '+stage,async()=>{
    const f=fixture();const deny=()=>{f.ctx.chatMetadata[KEY].modules.status.write=false;};
    try{if(stage==='generate'){f.callback=deny;await assert.rejects(f.api.generate(request),/允许模型更新/);}else{const draft=await f.api.generate(request);if(stage==='stage'){deny();assert.throws(()=>f.api.stage(draft.changes),/允许模型更新/);}else{f.api.stage(draft.changes);f.sourceCallback=deny;await assert.rejects(f.api.confirm(),/允许模型更新/);}}assert.equal(f.saves,0);assert.equal(status.read(f.ctx).项目.玩家.生命,10);}finally{f.dispose();}
});

for(const mutate of [f=>{f.ctx.chat[1].mes='剧情已编辑';},f=>{f.ctx.chat[1].swipe_id=1;},f=>{f.ctx.chatMetadata.variables.状态栏=JSON.stringify({...state(),项目:{玩家:{生命:3}}});},f=>{f.ctx.extensionSettings.world_status_hud_v1={globalRules:[{enabled:true,scope:'update',content:'新规则'}]};}])test('status stale source/state/rules reject confirmation after asynchronous reread '+String(mutate),async()=>{
    const f=fixture();try{const draft=await f.api.generate(request);f.api.stage(draft.changes);f.sourceCallback=()=>mutate(f);await assert.rejects(f.api.confirm(),/已变化/);assert.equal(f.saves,0);assert.equal(f.ctx.chatMetadata[KEY].applied.length,0);}finally{f.dispose();}
});

for(const independent of [false,true])test('status failed-save retry preserves one receipt and one application '+independent,async()=>{
    const f=fixture({independent});try{const draft=await f.api.generate(request);f.api.stage(draft.changes);f.fail=true;await assert.rejects(f.api.confirm(),/保存失败/);assert.equal(f.api.dirty(),true);const committed=structuredClone(f.ctx.chatMetadata);f.fail=false;await f.api.retrySave();assert.deepEqual(f.ctx.chatMetadata,committed);assert.equal(f.ctx.chatMetadata[KEY].applied.length,1);assert.equal(f.calls.length,1);assert.equal(f.saves,2);if(independent)assert.equal(f.ctx.chatMetadata[STATE_KEY].revision,1);}finally{f.dispose();}
});

test('status cancellation, empty output and repeated identical proposal never autoapply',async()=>{
    const f=fixture({mode:'auto'});try{f.callback=()=>f.api.cancel();await assert.rejects(f.api.generate(request),/已取消/);assert.equal(f.saves,0);f.callback=null;f.changes=[];const empty=await f.api.generate(request);assert.deepEqual(empty.changes,[]);assert.throws(()=>f.api.stage([]),/没有需要更新/);assert.equal(f.saves,0);
        f.changes=[set('玩家.生命',9)];await f.api.generate(request);f.api.stage(f.api.draft().changes);await f.api.confirm();await f.api.generate(request);assert.throws(()=>f.api.stage(f.api.draft().changes),/已经应用/);assert.equal(f.saves,1);
    }finally{f.dispose();}
});

test('manual status coordinator independently enforces set-only and write permissions',async()=>{
    const f=fixture();const api=createLinkageService(()=>f.ctx,{manualModules:['status']});
    try{assert.throws(()=>api.stage({version:1,changes:[{...set('玩家.生命',9),action:'adjust',data:{delta:-1}}]}),/仅允许/);
        f.ctx.chatMetadata[KEY].modules.status.write=false;assert.throws(()=>api.stage({version:1,changes:[set('玩家.生命',9)]}),/更新范围/);assert.equal(f.saves,0);
    }finally{api.dispose();f.dispose();}
});

for(const independent of [false,true])test('closing and reopening a failed status save exposes retry without another model call '+independent,async()=>{
    const f=fixture({independent});let reopened;
    try{await f.api.generate(request);f.api.stage(f.api.draft().changes);f.fail=true;await assert.rejects(f.api.confirm(),/保存失败/);const committed=structuredClone(f.ctx.chatMetadata);f.api.dispose();
        reopened=createGenerationService(()=>f.ctx,{ai:{capture(){throw Error('must not call AI');}}});assert.equal(reopened.dirty(),true);await assert.rejects(reopened.generate(request),/重试/);f.fail=false;await reopened.retrySave();assert.equal(reopened.dirty(),false);assert.equal(f.saves,2);assert.deepEqual(f.ctx.chatMetadata,committed);assert.equal(f.calls.length,1);
    }finally{reopened?.dispose();f.dispose();}
});

test('double confirmation during source reread commits only once',async()=>{
    const f=fixture();let release,entered;const ready=new Promise(resolve=>entered=resolve);
    try{await f.api.generate(request);f.api.stage(f.api.draft().changes);f.sourceCallback=async()=>{entered();await new Promise(resolve=>release=resolve);};const pending=f.api.confirm();await ready;await assert.rejects(f.api.confirm(),/当前生成/);release();await pending;assert.equal(f.saves,1);assert.equal(f.ctx.chatMetadata[KEY].applied.length,1);}finally{f.dispose();}
});

test('disposing during asynchronous confirmation reread never writes',async()=>{
    const f=fixture();let release,entered;const ready=new Promise(resolve=>entered=resolve);
    try{await f.api.generate(request);f.api.stage(f.api.draft().changes);f.sourceCallback=async()=>{entered();await new Promise(resolve=>release=resolve);};const before=structuredClone(f.ctx.chatMetadata),pending=f.api.confirm();await ready;f.api.dispose();release();await assert.rejects(pending,/关闭/);assert.deepEqual(f.ctx.chatMetadata,before);assert.equal(f.saves,0);}finally{f.dispose();}
});
