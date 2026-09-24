import test from 'node:test';
import assert from 'node:assert/strict';
import {captureHostRoute, getHostRouteOptions, observeHostGeneration, runHostGeneration} from '../ai/host-generation.js';
import {createHostRoutes} from '../ai/host-settings.js';

function harness() {
    const callbacks = new Map();
    const eventTypes = {GENERATION_STARTED:'started',GENERATION_ENDED:'ended',GENERATION_STOPPED:'stopped'};
    const eventSource = {on(name,fn){const list=callbacks.get(name)||[];list.push(fn);callbacks.set(name,list);},emit(name,...args){for(const fn of callbacks.get(name)||[])fn(...args);}};
    const profile = {id:'st-profile',name:'酒馆备用',api:'openai',model:'model-one',preset:'采样甲'};
    const calls=[];
    const service={getSupportedProfiles:()=>[profile],sendRequest:async(...args)=>{calls.push(args);return {content:'host text'};}};
    const ctx={chatId:'chat-one',getCurrentChatId(){return this.chatId;},chatMetadata:{},chat:[{mes:'开场',swipe_id:0}],characterId:0,groupId:null,
        mainApi:'openai',CONNECT_API_MAP:{openai:{selected:'openai'}},chatCompletionSettings:{chat_completion_source:'openai',openai_model:'model-one'},
        getChatCompletionModel:settings=>settings.openai_model,
        getPresetManager:()=>({getSelectedPresetName:()=> '完整预设甲',getCompletionPresetByName:name=>name==='采样甲'?{name}:null}),eventTypes,eventSource,
        ConnectionManagerRequestService:service,generateQuietPrompt:async args=>{calls.push(args);return 'quiet text';}};
    return {ctx,profile,calls,eventSource};
}

const request={systemPrompt:'只输出 JSON',prompt:'整理当前事件'};
const messages=[{role:'system',content:request.systemPrompt},{role:'user',content:request.prompt}];
const storage=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};};

test('new host route bindings preserve the default Amin route and persist by app',()=>{
    const store=storage(),first=createHostRoutes(store,'test');
    assert.deepEqual(first.get('map'),{mode:'amin',profileId:''});
    first.set('map',{mode:'tavern-profile',profileId:'st-profile'});
    assert.deepEqual(createHostRoutes(store,'test').get('map'),{mode:'tavern-profile',profileId:'st-profile'});
    assert.deepEqual(first.get('reply'),{mode:'amin',profileId:''});
});

test('native profile uses SillyTavern server service and its attached settings preset',async()=>{
    const {ctx,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'});
    assert.equal(getHostRouteOptions(ctx).profiles[0].preset,'采样甲');
    const text=await runHostGeneration({ctx,route,request,messages,maxTokens:111, getContext:()=>ctx});
    assert.equal(text,'host text');
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].slice(0,3),['st-profile',messages,111]);
    assert.equal(calls[0][3].includePreset,true);
    assert.equal(calls[0][3].stream,false);
});

test('missing or changed native profile fails before sending, with no fallback',async()=>{
    const {ctx,profile,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'});
    profile.model='model-two';
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx}),/已变化/);
    ctx.ConnectionManagerRequestService.getSupportedProfiles=()=>[];
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx}),/已删除/);
    assert.equal(calls.length,0);
});

test('Tauri hides and rejects Text Completion profiles while ordinary SillyTavern keeps them',()=>{
    const {ctx}=harness();
    ctx.CONNECT_API_MAP.openai.selected='textgenerationwebui';
    const hadMarker=Object.hasOwn(globalThis,'__TAURI_RUNNING__'),oldMarker=globalThis.__TAURI_RUNNING__;
    try {
        globalThis.__TAURI_RUNNING__=true;
        assert.deepEqual(getHostRouteOptions(ctx).profiles,[]);
        assert.throws(()=>captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'}),/Text Completion/);
        globalThis.__TAURI_RUNNING__=false;
        assert.equal(getHostRouteOptions(ctx).profiles[0].id,'st-profile');
        assert.equal(captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'}).profileId,'st-profile');
    } finally {
        if(hadMarker)globalThis.__TAURI_RUNNING__=oldMarker;else delete globalThis.__TAURI_RUNNING__;
    }
});

test('a deleted configured profile preset is rejected before the native request',async()=>{
    const {ctx,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'});
    ctx.getPresetManager=()=>({getSelectedPresetName:()=> '完整预设甲',getCompletionPresetByName:()=>null});
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx}),/生成参数预设.*已删除/);
    assert.equal(calls.length,0);
});

test('quiet route follows current full preset and rejects a changed preset before calling host',async()=>{
    const {ctx,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-current'});
    assert.equal(await runHostGeneration({ctx,route,request,messages,sharedPrompt:'持续效果',maxTokens:200,getContext:()=>ctx}),'quiet text');
    assert.match(calls[0].quietPrompt,/整理当前事件/);
    assert.match(calls[0].quietPrompt,/持续效果/);
    assert.equal(calls[0].responseLength,200);
    ctx.getPresetManager=()=>({getSelectedPresetName:()=> '完整预设乙'});
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:200,getContext:()=>ctx}),/预设已变化/);
    assert.equal(calls.length,1);
});

test('quiet route waits for active normal generation and protects next call after cancellation',async()=>{
    const {ctx,eventSource,calls}=harness();
    const route=captureHostRoute(ctx,{mode:'tavern-current'});
    observeHostGeneration(ctx);
    eventSource.emit('started','normal',{},false);
    const first=runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,0);
    eventSource.emit('ended');
    let finish;
    ctx.generateQuietPrompt=async args=>{calls.push(args);return await new Promise(resolve=>finish=resolve);};
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);
    const controller=new AbortController();
    const second=runHostGeneration({ctx,route,request,messages,maxTokens:100,signal:controller.signal,getContext:()=>ctx});
    controller.abort();
    await assert.rejects(second);
    assert.equal(calls.length,1);
    finish('late');
    assert.equal(await first,'late');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);
});

test('queued quiet route rejects an active model change before calling the host',async()=>{
    const {ctx,eventSource,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-current'});
    observeHostGeneration(ctx);
    eventSource.emit('started','normal',{},false);
    const pending=runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx});
    await new Promise(resolve=>setImmediate(resolve));
    ctx.chatCompletionSettings.openai_model='model-two';
    eventSource.emit('ended');
    await assert.rejects(pending,/当前连接或预设已变化/);
    assert.equal(calls.length,0);
});

test('quiet route rechecks when the stop button hides after the generation-ended event',async()=>{
    const {ctx,eventSource,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-current'});
    const oldDocument=globalThis.document,oldStyle=globalThis.getComputedStyle;
    let stopVisible=true;
    globalThis.document={getElementById:id=>id==='mes_stop'?{}:null};
    globalThis.getComputedStyle=()=>({display:stopVisible?'block':'none'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('stop button transition was not rechecked')),250);
    try {
        observeHostGeneration(ctx);
        eventSource.emit('started','normal',{},false);
        const pending=runHostGeneration({ctx,route,request,messages,maxTokens:100,signal:controller.signal,getContext:()=>ctx});
        await new Promise(resolve=>setImmediate(resolve));
        eventSource.emit('ended');
        await Promise.resolve();
        stopVisible=false;
        assert.equal(await pending,'quiet text');
        assert.equal(calls.length,1);
    } finally {
        clearTimeout(timer);
        if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
        if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
    }
});

test('native response after chat switch is discarded',async()=>{
    const {ctx}=harness(),route=captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'});
    ctx.ConnectionManagerRequestService.sendRequest=async()=>{ctx.chatId='other';return {content:'late'};};
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>ctx}),/聊天或楼层已变化/);
});

test('host routes reject a different active context before sending',async()=>{
    const {ctx,calls}=harness(),route=captureHostRoute(ctx,{mode:'tavern-profile',profileId:'st-profile'});
    const other={...ctx,chatId:'other',chatMetadata:{},chat:[{mes:'别的聊天'}],getCurrentChatId(){return this.chatId;}};
    await assert.rejects(runHostGeneration({ctx,route,request,messages,maxTokens:100,getContext:()=>other}),/聊天或楼层已变化/);
    assert.equal(calls.length,0);
});
