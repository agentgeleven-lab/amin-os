import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { STATE_KEY, emptyState, validateState } from '../apps/story-state/schema.js';
import { createSavesService } from '../apps/saves/service.js';
import { materialize, restorePatches } from '../apps/saves/adapters.js';
import * as Characters from '../apps/characters/model.js';
import * as Inventory from '../apps/inventory/model.js';
import * as Relationships from '../apps/relationships/model.js';
import * as Scene from '../apps/scene/model.js';
import * as Journal from '../apps/journal/model.js';
import * as Organizations from '../apps/organizations/model.js';
import * as Linkage from '../apps/linkage/policy.js';
import { LIBRARY_KEY } from '../apps/information/model.js';
import { createDemoDocument } from '../apps/map/src/core/demo.js';
import { rollBatch, formatRoll } from '../apps/dice/engine.js';

const clone = value => structuredClone(value), at = '2026-10-10T00:00:00.000Z';
function fixture(){
    let ids=0,saves=0;
    const ctx={chatId:'named-independent',characterId:0,characters:[{avatar:'hero.png'}],getCurrentChatId(){return this.chatId;},
        chat:[{is_user:false,name:'甲',mes:'正文保持原样',swipe_id:0}],extensionSettings:{theme:'keep',apiKey:'keep'},
        chatMetadata:{[STATE_KEY]:emptyState({updatedAt:at}),variables:{状态栏:'inert-native',Foreign:'keep'},LWB_RULES_V2:{Foreign:{ro:true}},world_info:'keep'},
        async saveMetadata(){saves++;}};
    const backups={available:()=>true,status:()=>({available:true,count:0}),savePrevious:async()=>{},list:async()=>[]};
    const runtime=createStoryStateRuntime(()=>ctx,{backups});
    const api=createSavesService(()=>ctx,{autoCheckpoints:false,createId:()=> 'named_'+(++ids),now:()=>at});
    return {ctx,runtime,api,get saves(){return saves;},dispose(){api.dispose();runtime.destroy();}};
}
function populated(){
    const state=emptyState({updatedAt:at});
    state.modules.characters={version:1,characters:[{id:'person',name:'甲',kind:'pc',notes:'保留',stats:[]}]};
    state.modules.inventory={...Inventory.emptyState(),items:[{id:'item',ownerId:'person',name:'物品',notes:'',quantity:2,equipped:false}]};
    state.modules.relationships=Relationships.emptyState();
    state.modules.scene={...Scene.emptyState(),clock:{year:2026,month:10,day:10,hour:0,minute:0,calendarLabel:''}};
    state.modules.effects={version:1,enabled:true,limit:30000,effects:[],consumedActionIds:['consumed']};
    state.modules.journal={version:1,limit:40000,entries:[Journal.validateRecord({id:'fact',kind:'fact',title:'事实',body:'内容',enabled:false},[])]};
    state.modules.information={version:1,enabled:true,limit:40000,records:[{id:'record',name:'甲',kind:'person',mode:'retcon',fields:[]}],modificationHistory:[]};
    state.modules.map=createDemoDocument();
    state.modules.status={版本:1,项目:{甲:{力量:12}}};
    state.modules.organizations={version:1,doc:Organizations.empty(),locks:[],assessment:null};
    const roll=rollBatch({formula:'1d20'},()=>14),record={id:'roll',createdAt:1,settings:roll.settings,results:roll.results,status:'appended',pending:{chatKey:'old',firstIndex:1}};
    record.text=formatRoll(record);state.modules.dice={version:1,rolls:[record]};
    return validateState(state);
}

test('restoring a real empty named save clears populated independent modules without altering body or settings',async()=>{
    const f=fixture();
    try{
        f.api.stageSave({name:'空白存档'});await f.api.confirm();
        const saved=f.api.read().saves[0];
        f.ctx.chatMetadata[STATE_KEY]=populated();
        const record={id:'library_record',name:'资料库',kind:'thing',mode:'forward',fields:[]};
        f.ctx.chatMetadata[LIBRARY_KEY]=[{record,search:null,at}];
        f.ctx.chatMetadata[Linkage.KEY]=Linkage.emptyLinkageState();
        const protectedData=clone({chat:f.ctx.chat,settings:f.ctx.extensionSettings,variables:f.ctx.chatMetadata.variables,rules:f.ctx.chatMetadata.LWB_RULES_V2,world:f.ctx.chatMetadata.world_info,library:f.ctx.chatMetadata[LIBRARY_KEY],linkage:f.ctx.chatMetadata[Linkage.KEY]});
        f.api.stageRestore(saved.id);await f.api.confirm();
        for(const [name,value]of Object.entries(f.ctx.chatMetadata[STATE_KEY].modules))assert.equal(value,null,`${name} must be cleared`);
        assert.deepEqual(Characters.readCharacters(f.ctx).characters,[]);
        assert.deepEqual({chat:f.ctx.chat,settings:f.ctx.extensionSettings,variables:f.ctx.chatMetadata.variables,rules:f.ctx.chatMetadata.LWB_RULES_V2,world:f.ctx.chatMetadata.world_info,library:f.ctx.chatMetadata[LIBRARY_KEY],linkage:f.ctx.chatMetadata[Linkage.KEY]},protectedData);
        assert.equal(f.api.read().backups.length,1);
        assert.equal(f.api.read().backups[0].modules.characters.characters[0].name,'甲');
    }finally{f.dispose();}
});

test('independent full restore resets appended dice to fixed rolled records and leaves the chat input untouched',async()=>{
    const f=fixture();
    try{
        const source=populated(),original=clone(source),body=clone(f.ctx.chat);
        const result=restorePatches(f.ctx,source.modules,{at});
        assert.equal(result.patches[0].path[0],STATE_KEY);
        assert.equal(result.patches[0].value.modules.dice.rolls[0].status,'rolled');
        assert.equal(result.patches[0].value.modules.dice.rolls[0].pending,undefined);
        assert.match(result.warnings.join('\n'),/聊天输入框不会改写/);
        assert.deepEqual(source,original);
        assert.deepEqual(f.ctx.chat,body);
        assert.equal(materialize(f.ctx).characters,null);
    }finally{f.dispose();}
});
