import test from 'node:test';
import assert from 'node:assert/strict';
import {createAI} from '../ai/service.js';

const storage=()=>{const items=new Map();return {getItem:k=>items.get(k)??null,setItem:(k,v)=>items.set(k,v),removeItem:k=>items.delete(k),dump:()=>JSON.stringify([...items])};};
function context() {
    const profile={id:'profile-one',name:'备用模型',api:'openai',model:'model',preset:'采样预设'};
    const calls=[];
    const ctx={chatId:'chat',getCurrentChatId(){return this.chatId;},chatMetadata:{},chat:[{mes:'开场'}],characterId:0,mainApi:'openai',
        eventSource:{on(){}},eventTypes:{},getPresetManager:()=>({getSelectedPresetName:()=> '剧情预设'}),
        generateQuietPrompt:async options=>{calls.push({kind:'quiet',options});return 'quiet output';},
        ConnectionManagerRequestService:{getSupportedProfiles:()=>[profile],sendRequest:async(...args)=>{calls.push({kind:'profile',args});return {content:'profile output'};}},
    };
    return {ctx,calls};
}
const request={systemPrompt:'只输出 JSON',prompt:'整理剧情'};

test('service routes one app through current Tavern preset without changing Amin profiles',async()=>{
    const store=storage(),{ctx,calls}=context();
    const ai=createAI(store,'host-current',{getHostContext:()=>ctx,resolveConnection:()=>{throw Error('legacy route reached');}});
    ai.profiles.save('amin-profile','Amin 模型',{...ai.settings.snapshot(),enabled:true,baseUrl:'https://unused.test/v1',model:'unused'});
    ai.setChannel('map','amin-profile');
    ai.setRoute('map',{mode:'tavern-current'});
    assert.equal(ai.route('map').mode,'tavern-current');
    assert.equal(ai.channel('map'),'amin-profile');
    assert.equal(await ai.generate('map',ctx,request),'quiet output');
    assert.equal(calls.length,1);
    assert.equal(calls[0].kind,'quiet');
    assert.match(ai.previews()[0].text,/Quiet 触发器/);
    assert.match(ai.previews()[0].text,/剧情预设/);
    assert.equal(createAI(store,'host-current',{getHostContext:()=>ctx}).route('map').mode,'tavern-current');
});

test('service routes journal to a saved Tavern connection and reports the preset scope',async()=>{
    const {ctx,calls}=context();
    ctx.chatMetadata.amin_os_journal_v1={version:999,events:[]};
    ctx.chatMetadata.amin_os_scene_v1={version:999,events:[]};
    const ai=createAI(storage(),'host-profile',{getHostContext:()=>ctx,resolveConnection:()=>{throw Error('legacy route reached');}});
    ai.setRoute('journal',{mode:'tavern-profile',profileId:'profile-one'});
    assert.equal(await ai.generate('剧情档案 · 编年史',ctx,request,{includeEffects:false,includeJournal:false,includeScene:false}),'profile output');
    assert.equal(calls[0].kind,'profile');
    assert.equal(calls[0].args[0],'profile-one');
    assert.equal(calls[0].args[3].includePreset,true);
    assert.match(ai.previews()[0].text,/生成参数预设 采样预设/);
    assert.match(ai.previews()[0].text,/不加入酒馆 Prompt Manager/);
    assert.equal(ai.tasks()[0].channel,'酒馆 · 备用模型');
});

test('unsupported host route cannot be selected and never silently falls back',async()=>{
    const {ctx}=context();delete ctx.generateQuietPrompt;delete ctx.ConnectionManagerRequestService;
    const ai=createAI(storage(),'host-missing',{getHostContext:()=>ctx});
    assert.equal(ai.hostRoutes().quietAvailable,false);
    assert.equal(ai.hostRoutes().profileAvailable,false);
    assert.throws(()=>ai.setRoute('map',{mode:'tavern-current'}),/静默生成/);
    assert.throws(()=>ai.setRoute('map',{mode:'tavern-profile',profileId:'missing'}),/连接配置请求接口/);
    assert.equal(ai.route('map').mode,'amin');
});

test('current Tavern route refuses a shared preset that omits the application request',async()=>{
    const {ctx,calls}=context();
    const ai=createAI(storage(),'host-current-missing-request',{getHostContext:()=>ctx});
    ai.setRoute('map',{mode:'tavern-current'});
    const snapshot=ai.capture('map');
    snapshot.preset.blocks=[];
    await assert.rejects(ai.generate('map',ctx,request,{snapshot}),/本次要求/);
    assert.equal(calls.length,0);
});
