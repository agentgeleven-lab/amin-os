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
    // Production reply UI has candidates/settings only; no rewrite workflow.
    await evaluate(`(async()=>{
        __view.dispose();window.SillyTavern={getContext:()=>__ctx};
        __ctx.extensionSettings.reply_options_mvp={count:2,character:false,persona:false,world:false};
        __ctx.eventTypes.MESSAGE_SENT='message_sent';
        window.__candidateRequests=[];
        __ctx.generateRaw=async request=>{__candidateRequests.push(request);return JSON.stringify({options:[{text:'候选甲'},{text:'候选乙'}]});};
        const {mount}=await import('/apps/reply/workspace.js');
        window.__workspace=mount(document.getElementById('app'),{getContext:()=>__ctx});
        window.__reply=()=>document.getElementById('reply-options-panel');
        window.__replyLabel=label=>__reply().querySelector('[aria-label="'+label+'"]');
        window.__workClick=async (root,text)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error('missing '+text);b.click();await new Promise(r=>setTimeout(r,50));};
    })()`);
    assert.equal(await evaluate('__reply().querySelector(".ro-settings-page").hidden'),true);
    assert.equal(await evaluate('[...__reply().querySelectorAll("button")].some(b=>b.textContent==="改写草稿")'),false);
    await evaluate('__workClick(__reply(),"设置")');
    assert.equal(await evaluate('__reply().querySelector(".ro-main-page").hidden'),true);
    await evaluate(`__set(__replyLabel('文风预设名称'),'新设置文风');__set(__replyLabel('文风预设提示词'),'SMOKE-STYLE：短句。')`);
    await evaluate('__workClick(__reply(),"生成候选")');
    await evaluate('__workClick(__reply(),"设置")');
    assert.equal(await evaluate('__replyLabel("文风预设提示词").value'),'SMOKE-STYLE：短句。');
    await evaluate('__workClick(__reply().querySelector(".ro-style-manager"),"保存风格")');
    assert.equal(await evaluate('__replyLabel("候选文风").value'),'custom');
    await evaluate('__workClick(__reply(),"生成候选")');
    await evaluate('__workClick(__reply(),"生成选项")');
    assert.match(await evaluate('JSON.stringify(__candidateRequests.at(-1))'),/SMOKE-STYLE/);
    await evaluate('__reply().querySelector(".ro-card").click()');
    assert.equal(await evaluate('__reply().querySelectorAll(".ro-card").length'),2);
    await evaluate('__ctx.eventSource.emit("message_sent")');
    assert.equal(await evaluate('__reply().querySelectorAll(".ro-card").length'),0);
    await evaluate('__workClick(__reply(),"设置")');
    const settingsLayout=await evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
    assert.ok(settingsLayout.scroll<=Math.max(settingsLayout.client,390),'settings page overflows mobile viewport');
    assert.equal(await evaluate('__submits'),0);
    assert.deepEqual(errors,[]);
    console.log('PASS reply settings: no rewrite, preserved style drafts, saved style in generation, clear on send, 390px layout.');

    await send('Browser.close').catch(() => {});
} finally {
    socket?.close();
    child.kill();
    await new Promise(resolve => server.close(resolve));
}
