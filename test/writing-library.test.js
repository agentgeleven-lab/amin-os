import test from 'node:test';
import assert from 'node:assert/strict';
import {contentLibrary,styleLibrary,CONTENT_KEY,NONE_STYLE,contentInstruction,writingInstruction,contentSelection} from '../apps/reply/writing-library.js';
import {STORE_KEY,createStore,buildRequest,referenceSamples} from '../apps/stylewriter/model.js';
import {normalizeSettings,generateOptions} from '../apps/reply/generator.js';

const fixture=(settings={})=>({extensionSettings:settings,saveSettingsDebounced(){}});
test('content migration preserves all legacy prompts verbatim and is idempotent',()=>{
    const long=' 空格与原文 '.repeat(2000),ctx=fixture({reply_options_mvp:{normalPrompt:'自定义正常',nsfwPrompt:'旧私有要求',violencePrompt:long,contentMode:'violence'}});
    const library=contentLibrary(()=>ctx);
    assert.equal(library.get('violence').description,long);
    assert.equal(library.get('normal').description,'自定义正常');
    assert.equal(ctx.extensionSettings.reply_options_mvp.contentMode,'violence');
    assert.equal(library,contentLibrary(()=>ctx));
    library.save({name:'自建',description:'完整要求'});
    assert.equal(contentLibrary(()=>ctx).list().length,5);
    assert.equal(normalizeSettings({nsfwEnabled:true}).contentMode,'nsfw');
});
test('library CRUD allows empty prompts, unique names, copy, delete and restore; sentinel cannot be deleted',()=>{
    const ctx=fixture(),library=contentLibrary(()=>ctx);
    const saved=library.save({name:'日常',description:''});assert.equal(library.get(saved.id).description,'');
    library.save({name:'日常',description:'温和生活'},saved.id);
    assert.throws(()=>library.save({name:'日常',description:'重复'}),/已存在/);
    assert.throws(()=>library.save({name:NONE_STYLE.name,description:''}),/已存在/);
    assert.throws(()=>library.save({name:'密钥',description:'sk-abcdefghijklmnopqrstuvwxyz1234'}),/密钥/);
    const copied=library.save({name:'日常副本',description:library.get(saved.id).description});
    assert.notEqual(copied.id,saved.id);
    const token=library.remove(saved.id);assert.equal(contentSelection(library,saved.id).id,'none');
    library.restore(token);assert.equal(library.get(saved.id).description,'温和生活');
    assert.throws(()=>library.remove('none'),/不存在/);
    assert.equal(contentInstruction(NONE_STYLE),'');
});
test('deleting every seeded content style does not reseed on reload',()=>{
    const ctx=fixture(),lib=contentLibrary(()=>ctx);for(const p of lib.list())lib.remove(p.id);
    const reloaded=contentLibrary(()=>fixture(structuredClone(ctx.extensionSettings)));
    assert.deepEqual(reloaded.list(),[]);
});
test('shared style library preserves old selection and rewrite selection defaults independently to none',()=>{
    const ctx=fixture({[STORE_KEY]:{mode:'custom',selectedId:'old',presets:[{id:'old',name:'旧文风',description:'原文说明'}]},reply_options_mvp:{contentMode:'violence'}});
    const style=styleLibrary(()=>ctx);assert.equal(style,styleLibrary(()=>ctx));
    assert.equal(style.selectedId(),'old');assert.equal(style.contentMode(),'none');
    style.setContentMode('nsfw');assert.equal(ctx.extensionSettings.reply_options_mvp.contentMode,'violence');
    assert.equal(normalizeSettings({contentMode:'custom-id'}).contentMode,'custom-id');
});
test('shared unsaved-draft markers notify other pages and clear independently by owner',()=>{
    const lib=createStore(()=>fixture(),{seeds:[]}),a={},b={};let notices=0;lib.subscribe(()=>notices++);
    lib.setDraft(a,'x',true);lib.setDraft(b,'x',true);assert.equal(lib.hasDraft('x'),true);
    lib.clearDrafts(a);assert.equal(lib.hasDraft('x'),true);lib.setDraft(b,'x',false);assert.equal(lib.hasDraft('x'),false);assert.equal(notices,4);
});
test('content persistence sync rejection rolls back without destroying legacy data',()=>{
    const ctx=fixture({reply_options_mvp:{nsfwPrompt:'旧内容'}}),lib=contentLibrary(()=>ctx),before=structuredClone(ctx.extensionSettings[CONTENT_KEY]);
    ctx.saveSettingsDebounced=()=>{throw Error('磁盘错误');};
    assert.throws(()=>lib.save({name:'失败',description:'内容'}),/磁盘/);
    assert.deepEqual(ctx.extensionSettings[CONTENT_KEY],before);assert.equal(lib.list().length,4);
    assert.equal(ctx.extensionSettings.reply_options_mvp.nsfwPrompt,'旧内容');
});
test('custom style and content instructions remain separate and preserve entire descriptions',()=>{
    const prose='完整文风'.repeat(5000),theme='悬疑内容'.repeat(5000);
    const a=writingInstruction({mode:'custom',preset:{name:'冷峻',description:prose}}),b=contentInstruction({name:'悬疑',description:theme});
    assert.ok(a.includes(prose));assert.ok(b.includes(theme));assert.equal(writingInstruction(), '');
    assert.throws(()=>writingInstruction({mode:'custom'}),/不存在/);
});
test('rewrite none/custom modes use no chat samples; content style cannot relax preservation contract',()=>{
    const none=buildRequest({mode:'none',source:'原始事实',samples:{samples:[{text:'不应使用'}]}});
    assert.ok(!none.prompt.includes('不应使用'));assert.equal(none.meta.sampleCount,0);
    const custom=buildRequest({mode:'custom',source:'原始事实',preset:{name:'简洁',description:'短句'}});
    custom.systemPrompt+=contentInstruction({name:'悬疑',description:'信息差'},true);
    assert.match(custom.systemPrompt,/不得改变事实、人物关系、事件顺序/);assert.match(custom.systemPrompt,/不新增情节/);
});
test('candidate generation applies only selected custom content and style in one request',async()=>{
    let request,calls=0;
    const ctx={chat:[{name:'角色',mes:'现有剧情',is_system:false}],name1:'我',characters:[],generateRaw:async r=>{calls++;request=r;return JSON.stringify({options:[{text:'候选一'},{text:'候选二'}]});}};
    await generateOptions(ctx,{count:2,contentMode:'violence',violencePrompt:'不能注入的旧要求',character:false,world:false},{world:[],contentStyle:{id:'mine',name:'日常',description:'只能出现日常倾向'},writingStyle:{mode:'custom',preset:{name:'克制',description:'短句简洁'}}});
    assert.equal(calls,1);assert.match(request.systemPrompt,/只能出现日常倾向/);assert.match(request.systemPrompt,/短句简洁/);assert.ok(!request.systemPrompt.includes('不能注入的旧要求'));
});
test('chat style references retain last 16 full messages, not character-truncated',()=>{
    const long='长正文'.repeat(10000),ctx={chat:Array.from({length:20},(_,i)=>({mes:i===19?long:String(i)}))};
    const samples=referenceSamples(ctx);assert.equal(samples.included,16);assert.equal(samples.samples.at(-1).text,long);
    assert.ok(writingInstruction({mode:'chat',samples}).includes(long));
});
