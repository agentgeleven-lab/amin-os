// Dependency-free Edge/Chromium smoke test for the stylewriter app.
// Uses an isolated fixture page + fake AI: never calls a real model, never touches real chats.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!fs.existsSync(executable)) throw Error('Set AMIN_BROWSER to a Chromium executable');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-stylewriter-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/standard.css"><link rel="stylesheet" href="/apps/reply/style.css"><link rel="stylesheet" href="/settings/appearance.css"><style>body{margin:0;font:14px sans-serif;background:#202020;color:#fff;--amin-card:#292929;--amin-line:#666;--amin-text:#fff;--amin-muted:#ccc;--amin-gap:10px;--amin-font:13px;--amin-radius:6px;--amin-control:#333;--amin-accent:#7bbad3;--amin-ink:#111}*{box-sizing:border-box}#app{width:448px;max-width:100%;padding:10px}button,input,select,textarea{font:inherit}textarea,input,select{width:100%}</style></head><body><div id="amin-os"><div id="app" class="amin-ui"></div></div><form id="send_form"><textarea id="send_textarea" placeholder="发送消息…"></textarea></form></body></html>`;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { res.statusCode = 403; res.end(); return; }
    try { res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let socket;
const errors = [];
const pending = new Map();
let seq = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
    if (!fs.existsSync(portFile)) throw Error('Browser debugger failed to start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(Error(JSON.stringify(message.error))) : entry?.resolve(message.result); }
        else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ':' + (message.params.exceptionDetails.exception?.description ?? ''));
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    for (let i = 0; i < 100; i++) { if (await evaluate('!!document.getElementById("app")')) break; await delay(50); }

    // Isolated fixture context + gated fake AI (no real model, no real chat storage).
    await evaluate(`(async () => {
        const handlers = new Map();window.__handlers=handlers;
        const eventSource = { on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); }, off(type,fn){handlers.get(type)?.delete(fn);}, emit(type) { for (const fn of [...(handlers.get(type) ?? [])]) fn(); } };
        window.__ctx = {
            getCurrentChatId: () => window.__chatId,
            characterId: 0, groupId: null, name1: '测试用户', name2: '临溪',
            characters: [{ avatar: 'fixture.png', name: '临溪' }],
            chatMetadata: { note_title: 'fixture' },
            chat: [
                { name: '临溪', is_user: false, mes: '孤帆远影碧空尽，唯见长江天际流。他望着水面出神。' },
                { name: '测试用户', is_user: true, mes: '我顺着他的目光看去，心里一紧。' },
                { name: 'sys', is_user: false, is_system: true, mes: 'SYSTEM-ONLY' },
            ],
            extensionSettings: {}, saveSettingsDebounced() { window.__saves = (window.__saves ?? 0) + 1; },
            eventTypes: { CHAT_CHANGED: 'chat_changed' }, eventSource,
        };
        window.__chatId = 'fixture-a';
        window.__requests = [];
        window.__gate = null;
        window.__generate = (ctx, request, opts) => new Promise((resolve, reject) => { window.__requests.push({ request, signal: opts?.signal }); window.__gate = { resolve, reject }; });
        window.__ai = { capture: () => ({ config: { timeoutSeconds: 5 }, channelName: 'fixture', preset: {} }) };
        const { mount } = await import('/apps/stylewriter/view.js');
        window.__mount = options => mount(document.getElementById('app'), options ?? { getContext: () => window.__ctx, ai: () => window.__ai, generate: window.__generate });
        window.__view = window.__mount();
        window.__root = () => document.getElementById('stylewriter-app');
        window.__status = () => document.querySelector('.amin-stylewriter .amin-notice')?.textContent ?? '';
        window.__label = label => document.querySelector('.amin-stylewriter [aria-label="' + label + '"]');
        window.__click = async text => { const button = [...document.querySelectorAll('.amin-stylewriter button')].find(b => b.textContent === text || b.textContent.startsWith(text)); if (!button) throw Error('button not found: ' + text); button.click(); await new Promise(r => setTimeout(r, 30)); };
        window.__set = (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
        window.__inputEvents = 0;
        document.getElementById('send_textarea').addEventListener('input', () => window.__inputEvents++);
        window.__submits = 0;
        document.getElementById('send_form').addEventListener('submit', event => { window.__submits++; event.preventDefault(); });
        return true;
    })()`);

    // Repeated mounting binds exactly once.
    assert.equal(await evaluate('window.__mount() === window.__view'), true);
    assert.equal(await evaluate('document.querySelectorAll("#stylewriter-app").length'), 1);
    assert.equal(await evaluate('[...document.querySelectorAll(".amin-stylewriter button")].filter(b => b.textContent === "转换文风").length'), 1);

    // Preset CRUD persists into extensionSettings; delete needs confirmation and can be undone.
    await evaluate(`__click('自定义文风'); __click('新建预设'); __set(__label('预设名称'), '冷峻白描'); __set(__label('文风说明'), '只写可见的动作与物件，情绪藏在细节里。'); __click('保存新预设')`);
    assert.match(await evaluate('__status()'), /已保存/);
    assert.equal(await evaluate(`__ctx.extensionSettings.amin_os_stylewriter_v1.presets.some(p => p.name === '冷峻白描')`), true);
    assert.equal(await evaluate(`[...__label('文风预设').options].some(o => o.textContent === '冷峻白描')`), true);
    await evaluate(`__set(__label('文风预设'), __ctx.extensionSettings.amin_os_stylewriter_v1.presets.find(p => p.name === '细腻古典').id); __label('文风预设').dispatchEvent(new Event('change', { bubbles: true }))`);
    assert.equal(await evaluate(`__label('预设名称').value`), '细腻古典');
    await evaluate(`__set(__label('预设名称'), '未保存草稿'); __click('删除预设'); __click('确认删除「细腻古典」？')`);
    assert.equal(await evaluate(`__ctx.extensionSettings.amin_os_stylewriter_v1.presets.some(p => p.name === '细腻古典')`), false);
    await evaluate(`__click('撤销删除')`);
    assert.equal(await evaluate(`__ctx.extensionSettings.amin_os_stylewriter_v1.presets.some(p => p.name === '细腻古典')`), true);
    await evaluate(`__set(__label('文风预设'), __ctx.extensionSettings.amin_os_stylewriter_v1.presets.find(p => p.name === '冷峻白描').id)`);

    // Read the host chat input into the source area.
    await evaluate(`document.getElementById('send_textarea').value = '输入框里的原稿'; __click('读取聊天输入框')`);
    assert.equal(await evaluate(`__label('原文').value`), '输入框里的原稿');

    // Custom mode: real DOM conversion flow with a gated fake model; chat prose must stay out.
    await evaluate(`__click('转换文风')`);
    assert.equal(await evaluate('window.__requests.length'), 1);
    assert.match(await evaluate('window.__requests[0].request.prompt'), /输入框里的原稿/);
    assert.match(await evaluate('window.__requests[0].request.prompt'), /冷峻白描/);
    assert.equal(await evaluate(`window.__requests[0].request.prompt.includes('孤帆远影')`), false);
    assert.equal(await evaluate(`window.__requests[0].request.prompt.includes('临溪')`), false);
    assert.match(await evaluate('__status()'), /转换中.*自定义文风/);
    await evaluate(`window.__gate.resolve('<think>x</think>冷峻的改写结果。')`);
    await delay(80);
    assert.equal(await evaluate(`__label('转换结果').value`), '冷峻的改写结果。');
    assert.match(await evaluate('__status()'), /完成.*自定义文风/);

    // Fill back writes only a draft (input event, never submit), then blocks edited drafts.
    await evaluate(`__click('填回聊天输入框')`);
    assert.equal(await evaluate(`document.getElementById('send_textarea').value`), '冷峻的改写结果。');
    assert.equal(await evaluate('window.__submits'), 0);
    assert.ok(await evaluate('window.__inputEvents >= 1'));
    await evaluate(`__set(__label('转换结果'), '手动编辑后的结果'); document.getElementById('send_textarea').value = '用户刚写的新草稿'; __click('填回聊天输入框')`);
    assert.equal(await evaluate(`document.getElementById('send_textarea').value`), '用户刚写的新草稿');
    assert.match(await evaluate('__status()'), /不会覆盖新草稿/);

    // Reference mode: recent non-system chat prose is used as the style sample.
    await evaluate(`__click('参考当前聊天文风'); __set(__label('原文'), '参考模式原文'); __click('转换文风')`);
    assert.match(await evaluate('window.__requests[1].request.prompt'), /孤帆远影/);
    assert.equal(await evaluate(`window.__requests[1].request.prompt.includes('SYSTEM-ONLY')`), false);
    assert.match(await evaluate('__status()'), /样本 2 条/);
    await evaluate(`window.__gate.resolve('参考模式结果')`);
    await delay(80);
    assert.equal(await evaluate(`__label('转换结果').value`), '参考模式结果');

    // Chat switch mid-flight aborts application; drafts stay private per chat.
    await evaluate(`__set(__label('原文'), '迟到检验原文'); __click('转换文风')`);
    await evaluate(`window.__chatId = 'fixture-b'; __ctx.eventSource.emit('chat_changed')`);
    await delay(50);
    assert.match(await evaluate('__status()'), /聊天已切换/);
    assert.equal(await evaluate(`__label('原文').value`), '');
    await evaluate(`window.__gate.resolve('迟到的结果')`);
    await delay(80);
    assert.equal(await evaluate(`__label('转换结果').value`), '');
    await evaluate(`window.__chatId = 'fixture-a'; __ctx.eventSource.emit('chat_changed')`);
    await delay(50);
    assert.equal(await evaluate(`__label('原文').value`), '迟到检验原文');

    // Narrow screens must not overflow.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(60);
    const layout = await evaluate('({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, width: innerWidth})');
    // Allow a few px of scrollbar/rounding slack in the emulated viewport, but no horizontal overflow.
    assert.ok(Math.abs(layout.width - 390) <= 8, 'unexpected viewport width: ' + JSON.stringify(layout));
    assert.ok(layout.scroll <= Math.max(layout.client, 390), 'narrow page overflows: ' + JSON.stringify(layout));

    assert.deepEqual(errors, []);
    console.log('PASS real Chromium DOM: stylewriter mount-once, preset CRUD + undo, custom/reference isolation, gated conversion, guarded fill-back, per-chat privacy, 390px layout.');
    // The merged workspace uses real DOM with both production views and fake transports.
    await evaluate(`(async()=>{
        __view.dispose();
        window.SillyTavern={getContext:()=>__ctx};
        __ctx.extensionSettings.reply_options_mvp={count:2,character:false,persona:false,world:false};
        window.__candidateRequests=[];
        __ctx.generateRaw=async request=>{__candidateRequests.push(request);return JSON.stringify({options:[{text:'候选甲'},{text:'候选乙'}]});};
        const {mount}=await import('/apps/reply/workspace.js');
        window.__workspace=mount(document.getElementById('app'),{rewriteOptions:{getContext:()=>__ctx,ai:()=>__ai,generate:__generate}});
        window.__workspaceMount=mount;
        window.__reply=()=>document.getElementById('reply-options-panel');
        window.__replyLabel=label=>__reply().querySelector('[aria-label="'+label+'"]');
        window.__workClick=async (root,text)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error('missing '+text);b.click();await new Promise(r=>setTimeout(r,50));};
        const {contentLibrary,styleLibrary}=await import('/apps/reply/writing-library.js');
        window.__contents=contentLibrary(()=>__ctx);window.__styles=styleLibrary(()=>__ctx);
        window.__mystyle=__contents.save({name:'浏览器悬疑',description:'BROWSER-THEME'});
        __set(__replyLabel('内容风格'),__mystyle.id);
        __set(__replyLabel('候选文风'),'custom');
        __set(__replyLabel('候选文风预设'),__styles.list()[0].id);
        return true;
    })()`);
    assert.equal(await evaluate('__workspaceMount(document.getElementById("app"))===__workspace'),true);
    await evaluate('__workClick(__reply(),"生成选项")');
    assert.equal(await evaluate('__candidateRequests.length'),1);
    assert.match(await evaluate('__candidateRequests[0].systemPrompt'),/BROWSER-THEME/);
    assert.match(await evaluate('__candidateRequests[0].systemPrompt'),/目标文风/);
    // Candidate refinement uses production controls, preserves the other card and input.
    await evaluate(`(async()=>{
        window.__savedCandidateGenerator=__ctx.generateRaw;
        __ctx.generateRaw=async request=>{__candidateRequests.push(request);return JSON.stringify({options:[{text:'候选甲，更委婉地询问。'}]});};
        __set(__replyLabel('候选 1 修改要求'),'更委婉');
        __set(__replyLabel('候选 1 保留原句'),'候选甲');
        window.__inputBeforeRefine=document.getElementById('send_textarea').value;
        await __workClick(__reply(),'按要求调整');
    })()`);
    assert.deepEqual(await evaluate('[...__reply().querySelectorAll(".ro-card span")].map(n=>n.textContent)'),['候选甲，更委婉地询问。','候选乙']);
    assert.equal(await evaluate('document.getElementById("send_textarea").value===__inputBeforeRefine'),true);
    await evaluate(`(async()=>{
        __ctx.generateRaw=async request=>JSON.stringify({options:[{text:'未保留指定文字'}]});
        await __workClick(__reply(),'按要求调整');
        __reply().querySelector('.ro-refine').open=true;
        __reply().querySelector('.ro-references').open=true;
    })()`);
    assert.match(await evaluate('__reply().querySelector(".ro-status").textContent'),/未原样保留/);
    assert.equal(await evaluate('__reply().querySelector(".ro-card span").textContent'),'候选甲，更委婉地询问。');
    const refineLayout=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
    assert.ok(refineLayout.scroll<=Math.max(refineLayout.client,390),'expanded candidate controls overflow mobile width');
    await evaluate(`(async()=>{__ctx.generateRaw=__savedCandidateGenerator;await __workClick(__reply(),'生成 / 换一批');})()`);
    const rewritesBefore=await evaluate('__requests.length');
    await evaluate('__workClick(__reply(),"继续改写")');
    assert.equal(await evaluate('__label("原文").value'),'候选甲');
    assert.equal(await evaluate('__requests.length'),rewritesBefore);
    assert.equal(await evaluate('__label("内容风格").value'),'none');
    assert.equal(await evaluate('__reply().parentElement.hidden'),true);
    await evaluate(`__click('不额外指定文风'); __click('转换文风')`);
    assert.equal(await evaluate('__requests.length'),rewritesBefore+1);
    assert.equal(await evaluate('__requests.at(-1).request.systemPrompt.includes("BROWSER-THEME")'),false);
    await evaluate('__gate.resolve("合并后的改写结果")');await delay(80);
    assert.equal(await evaluate('__label("转换结果").value'),'合并后的改写结果');
    // Other page edits invalidate an in-flight conversion using that style.
    await evaluate(`__set(__label('内容风格'),__mystyle.id); __click('转换文风')`);
    await evaluate(`__contents.save({name:'浏览器悬疑',description:'BROWSER-CHANGED'},__mystyle.id); __gate.resolve('不能覆盖的迟到结果')`);await delay(80);
    assert.equal(await evaluate('__label("转换结果").value'),'合并后的改写结果');
    // Tab switches keep the source draft and preset editor mounted, not reconstructed.
    await evaluate(`(async()=>{__workspace.open('candidates');await __workClick(__reply(),'生成 / 换一批');await __workClick(__reply(),'继续改写');})()`);
    assert.equal(await evaluate('__label("原文").value'),'候选甲');
    assert.equal(await evaluate('__submits'),0);
    const mergedLayout=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
    assert.ok(mergedLayout.scroll<=Math.max(mergedLayout.client,390),'merged narrow page overflows');
    assert.deepEqual(errors,[]);
    console.log('PASS merged writing workspace: mount-once, single candidate call with theme/style, transfer without AI, independent choices, stale rewrite rejection, no auto-send, 390px layout.');
    // Production floor controls with two real workspace instances alongside the main pane.
    await evaluate(`(async()=>{
        __ctx.chat=[{name:'甲',mes:'FLOOR-ONE-SAMPLE'},{name:'乙',mes:'FLOOR-TWO-SAMPLE'},{name:'丙',mes:'FUTURE-FLOOR-SECRET'}];
        __ctx.extensionSettings.reply_options_mvp={count:2,character:false,persona:false,world:false,writingStyleMode:'chat',contentMode:'none'};
        __styles.setMode('chat');__styles.setContentMode('none');
        const chat=document.createElement('div');chat.id='chat';
        for(let i=0;i<3;i++){const e=document.createElement('div');e.className='mes';e.setAttribute('mesid',i);e.innerHTML='<div class="mes_block"></div>';chat.append(e);}
        document.getElementById('send_form').before(chat);
        window.__floorCalls=[];
        window.__floorGenerate=(ctx,request,opts)=>new Promise(resolve=>__floorCalls.push({ctx,request,signal:opts.signal,resolve}));
        window.__floor=idx=>document.querySelector('[mesid="'+idx+'"] .amin-reply-floor-window');
        window.__floorLabel=(idx,label)=>__floor(idx).querySelector('.amin-stylewriter [aria-label="'+label+'"]');
        window.__openFloor=idx=>document.querySelector('[mesid="'+idx+'"] .amin-floor-toolbar>button[data-floor-app="reply"]').click();
        window.__floorHandlerBaseline=__handlers.get('chat_changed').size;
        const {installReplyFloorButtons}=await import('/apps/reply/floor-ui.js');
        window.__floorInstaller=installReplyFloorButtons({rewriteOptions:{ai:()=>__ai,generate:__floorGenerate}});
        __openFloor(0);__openFloor(1);
        return true;
    })()`);
    assert.equal(await evaluate('document.querySelectorAll(".amin-writing-workspace").length'),3);
    assert.equal(await evaluate('(()=>{const ids=[...document.querySelectorAll("[id]")].map(n=>n.id);return new Set(ids).size===ids.length;})()'),true);
    // Another floor's saved defaults must not replace the choices visible in this window.
    await evaluate(`__set(__floor(1).querySelector('.ro-panel [aria-label="内容风格"]'),'violence')`);
    assert.equal(await evaluate(`__floor(0).querySelector('.ro-panel [aria-label="内容风格"]').value`),'none');
    const floorCandidatesBefore=await evaluate('__candidateRequests.length');
    await evaluate('__workClick(__floor(0),"生成选项")');
    assert.equal(await evaluate('__candidateRequests.length'),floorCandidatesBefore+1);
    assert.match(await evaluate('JSON.stringify(__candidateRequests.at(-1))'),/FLOOR-ONE-SAMPLE/);
    assert.doesNotMatch(await evaluate('JSON.stringify(__candidateRequests.at(-1))'),/FLOOR-TWO-SAMPLE|FUTURE-FLOOR-SECRET|突出动作冲突/);
    await evaluate('__workClick(__floor(0),"继续改写")');
    assert.equal(await evaluate('__floorLabel(0,"原文").value'),'候选甲');
    assert.equal(await evaluate('__label("原文").value'),'候选甲');
    assert.equal(await evaluate('__floorCalls.length'),0);
    assert.equal(await evaluate('__floor(0).querySelector(".ro-panel").parentElement.hidden'),true);
    await evaluate('__workClick(__floor(1),"管理文风预设")');
    assert.equal(await evaluate('__floor(1).querySelector(".ro-panel").parentElement.hidden'),true);
    await evaluate(`(async()=>{await __workClick(__floor(1),'参考当前聊天文风');__set(__floorLabel(1,'原文'),'第二楼原文');__set(document.getElementById('send_textarea'),'共享输入草稿');await __workClick(__floor(0),'转换文风');await __workClick(__floor(1),'转换文风');})()`);
    assert.deepEqual(await evaluate('__floorCalls.map(x=>x.ctx.chat.length)'),[1,2]);
    assert.doesNotMatch(await evaluate('JSON.stringify(__floorCalls[1].request)'),/FUTURE-FLOOR-SECRET/);
    await evaluate('__workClick(__floor(0),"收起")');
    assert.equal(await evaluate('__floorCalls[0].signal.aborted'),true);
    assert.equal(await evaluate('__floorCalls[1].signal.aborted'),false);
    await evaluate('__floorCalls[0].resolve("关闭后迟到");__floorCalls[1].resolve("第二楼有效结果")');await delay(80);
    assert.equal(await evaluate('__floorLabel(1,"转换结果").value'),'第二楼有效结果');
    const openFloorLayout=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,bodies:[...document.querySelectorAll(".amin-reply-floor-body")].map(n=>({scroll:n.scrollWidth,client:n.clientWidth}))})');
    assert.ok(openFloorLayout.scroll<=Math.max(openFloorLayout.client,390),'open floor overflows viewport');
    assert.ok(openFloorLayout.bodies.every(n=>n.scroll<=n.client+1),'floor content overflows its window: '+JSON.stringify(openFloorLayout));
    await evaluate(`__set(document.getElementById('send_textarea'),'用户新草稿');__workClick(__floor(1),'填回聊天输入框')`);
    assert.equal(await evaluate('document.getElementById("send_textarea").value'),'用户新草稿');
    await evaluate(`__set(document.getElementById('send_textarea'),'共享输入草稿');__workClick(__floor(1),'填回聊天输入框')`);
    assert.equal(await evaluate('document.getElementById("send_textarea").value'),'第二楼有效结果');
    assert.equal(await evaluate('__submits'),0);
    await evaluate('__openFloor(0)');
    assert.equal(await evaluate('__floorLabel(0,"原文").value'),'');
    assert.equal(await evaluate('__floorLabel(0,"转换结果").value'),'');
    // A replaced floor cannot accept its old pending result or retain the previous UI.
    await evaluate('__workClick(__floor(1),"转换文风")');
    await evaluate('__ctx.chat[1]={name:"新楼层",mes:"替换内容"};__floorInstaller.refresh()');
    // refresh is frame-coalesced, so wait for that frame before asserting teardown.
    for(let i=0;i<40 && !(await evaluate('__floorCalls.at(-1).signal.aborted'));i++)await delay(25);
    assert.equal(await evaluate('__floorCalls.at(-1).signal.aborted'),true);
    await evaluate('__floorCalls.at(-1).resolve("替换后迟到")');await delay(60);
    assert.equal(await evaluate('__floor(1)'),null);
    // Metadata replacement closes every old floor and releases its per-window listeners.
    await evaluate('__ctx.chatMetadata={replaced:true};__ctx.eventSource.emit("chat_changed")');await delay(80);
    assert.equal(await evaluate('document.querySelectorAll(".amin-reply-floor-window").length'),0);
    assert.equal(await evaluate('__handlers.get("chat_changed").size'),await evaluate('__floorHandlerBaseline+1'));
    await evaluate('(async()=>{for(let i=0;i<3;i++){__openFloor(0);await __workClick(__floor(0),"收起");}})()');
    assert.equal(await evaluate('__handlers.get("chat_changed").size'),await evaluate('__floorHandlerBaseline+1'));
    const floorLayout=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
    assert.ok(floorLayout.scroll<=Math.max(floorLayout.client,390),'floor narrow page overflows');
    assert.deepEqual(errors,[]);
    console.log('PASS floor writing workspaces: local handoff, bounded samples, unique IDs, independent tasks/results, guarded fill, deletion/metadata cleanup, listener cleanup and 390px layout.');
    await evaluate('__workspace.dispose()');

    // Fresh page: managed ownership must mount only the host-owned message node.
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("app") && !window.__ctx'))break;await delay(50);}
    await evaluate(`(async()=>{
        window.__managedCalls=[];window.__managedHandlers=new Map();
        const eventSource={on(t,f){if(!__managedHandlers.has(t))__managedHandlers.set(t,new Set());__managedHandlers.get(t).add(f);},off(t,f){__managedHandlers.get(t)?.delete(f);}};
        window.__ctx={chatId:'managed-chat',characterId:0,chatMetadata:{},name1:'我',name2:'角色',chat:[{name:'甲',mes:'托管楼层'},{name:'乙',mes:'非托管楼层'}],extensionSettings:{reply_options_mvp:{count:2,character:false,persona:false,world:false}},saveSettingsDebounced(){},eventTypes:{CHAT_CHANGED:'chat_changed'},eventSource};
        window.SillyTavern={getContext:()=>__ctx};
        window.__TAURITAVERN__={api:{chatSurface:{protocolVersion:1,isManagedOwnershipRequired:()=>true,registerParticipant(p){window.__participant=p;}}}};
        const chat=document.createElement('div');chat.id='chat';chat.innerHTML='<div class="mes" mesid="0"><div class="mes_block"></div></div><div class="mes" mesid="1"><div class="mes_block"></div></div>';document.body.append(chat);
        const {installReplyFloorButtons}=await import('/apps/reply/floor-ui.js');
        installReplyFloorButtons({rewriteOptions:{ai:()=>({capture:()=>({config:{timeoutSeconds:5}})}),generate:(ctx,request,opts)=>new Promise(resolve=>__managedCalls.push({signal:opts.signal,resolve}))}});
        window.__managedClick=text=>{const b=[...document.querySelectorAll('.amin-reply-floor-window button')].find(b=>b.textContent===text);if(!b)throw Error('missing '+text);b.click();};
        return true;
    })()`);
    assert.equal(await evaluate('document.querySelectorAll(".amin-floor-toolbar button").length'),0);
    await evaluate('__release=__participant.didMount({element:document.querySelector("[mesid=\\"0\\"]")});document.querySelector(".amin-floor-toolbar button").click();__managedClick("改写草稿")');
    assert.equal(await evaluate('document.querySelectorAll(".amin-writing-workspace").length'),1);
    assert.equal(await evaluate('document.querySelector("[mesid=\\"1\\"] .amin-floor")'),null);
    await evaluate(`(()=>{const source=document.querySelector('.amin-stylewriter [aria-label="原文"]');source.value='托管原文';source.dispatchEvent(new Event('input'));__managedClick('转换文风');})()`);await delay(50);
    assert.equal(await evaluate('__managedCalls.length'),1);
    await evaluate('__release();__managedCalls[0].resolve("卸载后迟到")');await delay(50);
    assert.equal(await evaluate('__managedCalls[0].signal.aborted'),true);
    assert.equal(await evaluate('document.querySelectorAll(".amin-writing-workspace").length'),0);
    assert.equal(await evaluate('__managedHandlers.get("chat_changed").size'),1);
    assert.deepEqual(errors,[]);
    console.log('PASS managed floor ownership: no unowned mounts, inline rewrite, unmount aborts and releases listeners.');


    await send('Browser.close').catch(() => {});
} finally {
    socket?.close();
    child.kill();
    await new Promise(resolve => server.close(resolve));
}
