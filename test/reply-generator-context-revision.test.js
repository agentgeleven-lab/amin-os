import test from 'node:test';
import assert from 'node:assert/strict';
import {generateOptions,normalizeSettings} from '../apps/reply/generator.js';
import {initializeAI} from '../ai/service.js';

const context=generateRaw=>({
    chat:[{name:'角色',mes:'门外传来脚步声。',is_system:false}],
    name1:'玩家',characters:[],generateRaw,
});
const response=(...texts)=>JSON.stringify({options:texts.map(text=>({text}))});

test('single direction keeps chosen linked facts and repeats full user requirements after style and context',async()=>{
    const longRequirement='请放慢语速。'.repeat(700);
    const settings=normalizeSettings({prompt:longRequirement,roleplaySystemPrompt:'必须先观察现场。',count:3});
    assert.equal(settings.prompt,longRequirement);
    assert.throws(()=>normalizeSettings({prompt:'字'.repeat(32001)}),/32000/);
    let request;
    const ctx=context(async value=>{request=value;return response('我停下来听脚步声。');});
    const options=await generateOptions(ctx,settings,{
        world:[],directions:['观察'],
        linkedContext:{records:[
            {id:'scene',module:'scene',label:'当前位置',text:'门外走廊',selected:true},
            {id:'secret',module:'relationships',label:'隐藏关系',text:'不应发送的秘密',selected:false},
        ]},
        contentStyle:{name:'急促',description:'句子必须急促'},
    });
    assert.equal(options.length,1);
    assert.equal(options[0].label,'观察');
    assert.match(request.systemPrompt,/必须先观察现场/);
    assert.ok(request.systemPrompt.indexOf('句子必须急促')>request.systemPrompt.indexOf('必须先观察现场'));
    assert.match(request.systemPrompt,/请放慢语速/);
    assert.match(request.prompt,/门外走廊/);
    assert.doesNotMatch(request.prompt,/不应发送的秘密/);
    assert.ok(request.prompt.lastIndexOf(longRequirement)>request.prompt.indexOf('门外走廊'));
    assert.match(request.prompt,/区分角色已知与玩家已知/);
});

test('single revision validates exact preserved text and keeps source candidate on model failure',async()=>{
    let raw=response('我压低声音说：“请等一下。”');
    const ctx=context(async()=>raw);
    const args={world:[],directions:['交涉'],revisionTask:{
        original:'我说：“请等一下。”',instruction:'压低声音，但保留原对白。',
        preserveText:'“请等一下。”',otherOptions:['我转身离开。'],
    }};
    const revised=await generateOptions(ctx,{count:3},args);
    assert.equal(revised[0].text,'我压低声音说：“请等一下。”');
    raw=response('我压低声音说：稍等。');
    await assert.rejects(generateOptions(ctx,{count:3},args),/未原样保留/);
    raw=response('我说：“请等一下。”');
    await assert.rejects(generateOptions(ctx,{count:3},args),/未调整原候选/);
    raw=response('我转身离开。');
    await assert.rejects(generateOptions(ctx,{count:3},{...args,revisionTask:{...args.revisionTask,preserveText:''}}),/已有候选/);
    assert.throws(()=>normalizeSettings({authorPrompt:'要求'.repeat(20000)}),/32000/);
});

test('batch regeneration accepts only requested directions and refuses duplicates of kept candidates',async()=>{
    let raw=response('我去观察门锁。','我向门外问话。');
    const ctx=context(async()=>raw);
    const args={world:[],directions:['观察','交涉'],revisionTask:{otherOptions:['我继续等待。']}};
    const generated=await generateOptions(ctx,{count:6},args);
    assert.deepEqual(generated.map(item=>item.label),['观察','交涉']);
    raw=response('我去观察门锁。','我继续等待。');
    await assert.rejects(generateOptions(ctx,{count:6},args),/已有候选/);
    await assert.rejects(generateOptions(ctx,{count:6},{...args,directions:[]}),/1 至 6/);
});

test('batch regeneration binds each preserved fragment to its original direction',async()=>{
    let request,raw=response('我守住门口，继续观察。','我抬起手，示意对方停下。');
    const ctx=context(async value=>{request=value;return raw;});
    const args={world:[],directions:['观察','交涉'],revisionTask:{
        instruction:'改写未保留的两条候选。',otherOptions:['我走向窗口。'],
        slots:[
            {original:'我守住门口。',preserveText:'守住门口'},
            {original:'我抬起手。',preserveText:'抬起手'},
        ],
    }};
    const generated=await generateOptions(ctx,{count:2},args);
    assert.equal(generated.length,2);
    assert.match(request.systemPrompt,/守住门口/);
    assert.match(request.prompt,/抬起手/);
    raw=response('我守住门口，继续观察。','我示意对方停下。');
    await assert.rejects(generateOptions(ctx,{count:2},args),/第 2 条指定文字/);
    raw=response('我抬起手，继续观察。','我守住门口，示意对方停下。');
    await assert.rejects(generateOptions(ctx,{count:2},args),/第 1 条指定文字/);
    await assert.rejects(generateOptions(ctx,{count:2},{...args,revisionTask:{...args.revisionTask,slots:[args.revisionTask.slots[0]]}}),/方向数量不一致/);
});

test('shared route carries selected context and does not append unrelated default story context',async()=>{
    const map=new Map(),store={getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
    const ai=initializeAI(store,'reply-context-test',{getHostContext:()=>({})});
    const originalGenerate=ai.generate;
    let seen;
    try {
        ai.generate=async(...args)=>{seen=args;return response('我抬头查看天空。');};
        const result=await generateOptions(context(()=>{throw Error('shared route expected');}),{count:3},{world:[],directions:['观察'],linkedContext:{records:[{module:'scene',label:'天气',text:'正在下雨'}]}});
        assert.equal(result.length,1);
        assert.match(seen[2].prompt,/正在下雨/);
        assert.match(seen[3].data.request,/正在下雨/);
        for(const key of ['includeEffects','includeJournal','includeScene','includeLinkage']) assert.equal(seen[3][key],false);
        ai.settings.save({...ai.settings.snapshot(),requestBody:'{"messages":[{"role":"user","content":"覆写"}]}'});
        await assert.rejects(generateOptions(context(()=>{}),{count:3},{world:[],directions:['观察']}),/覆盖了 messages/);
    } finally {ai.generate=originalGenerate;}
});
