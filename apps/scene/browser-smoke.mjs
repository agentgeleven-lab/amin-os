// Isolated browser fixture: no real host/chat state, no external API requests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../..');
const browser = process.env.AMIN_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!fs.existsSync(browser)) throw Error('Set AMIN_BROWSER to a Chromium browser executable.');
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/standard.css"><style>body{margin:0;--amin-text:#eee;--amin-muted:#bbb;--amin-card:#222;--amin-control:#333;--amin-line:#777;--amin-accent:#caa5ef;--amin-ink:#111;--amin-radius:8px;--amin-font:14px;--amin-gap:12px;background:#111}#app{max-width:760px;margin:auto}</style></head><body><div id="amin-os"><div id="app" class="amin-ui"></div></div></body></html>';
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(html); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-scene-browser-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, sequence = 0;
const pending = new Map(), errors = [];
const deadline = setTimeout(() => { console.error('Scene browser smoke timed out before completion.'); socket?.close(); child.kill(); server.closeAllConnections(); server.close(); process.exitCode = 1; }, 30000);
try {
    const activePort = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(activePort); i++) await delay(100);
    const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Browser debugger connection timed out')), 10000); socket.onopen = () => { clearTimeout(timeout); resolve(); }; socket.onerror = error => { clearTimeout(timeout); reject(error); }; });
    socket.onmessage = event => {
        const value = JSON.parse(event.data);
        if (value.id) { const request = pending.get(value.id); pending.delete(value.id); if (value.error) request?.reject(Error(JSON.stringify(value.error))); else request?.resolve(value.result); }
        else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    for (let i = 0; i < 100; i++) { if (await evaluate('!!document.getElementById("app")')) break; await delay(50); }
    await evaluate(`(async()=>{
      window.ctx={chat:[],chatMetadata:{},characterId:0,getCurrentChatId:()=> 'scene-browser',saveMetadata:async()=>{}};
      window.SillyTavern={getContext:()=>ctx}; window.model=await import('/apps/scene/model.js');
      const {mount}=await import('/apps/scene/view.js');window.sceneView=mount(document.getElementById('app')); window.mountScene=()=>mount(document.getElementById('app'));
      window.click=async label=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===label);if(!b)throw Error('missing button '+label);if(b.disabled)throw Error('disabled button '+label);b.click();await new Promise(r=>setTimeout(r,15));};
      window.fill=(label,value)=>{const wrapper=[...document.querySelectorAll('label')].find(el=>el.querySelector('span')?.textContent===label);const input=wrapper?.querySelector('input,textarea,select');if(!input)throw Error('missing field '+label);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
      window.tick=label=>{const wrap=[...document.querySelectorAll('label')].find(el=>el.querySelector('span')?.textContent===label);const input=wrap.querySelector('input');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));};
    })()`);
    assert.deepEqual(await evaluate('ctx.chatMetadata'), {});
    assert.equal(await evaluate('mountScene()===sceneView'), true); assert.equal(await evaluate('document.querySelectorAll(".amin-scene").length'), 1);
    await evaluate("fill('年','1925');fill('月','12');fill('日','31');fill('时','23');fill('分','50');click('预览时间设置')");
    assert.equal(await evaluate('model.readCurrentScene(ctx).clock'), null);
    await evaluate("click('确认应用一次')"); assert.equal(await evaluate('model.readCurrentScene(ctx).clock.year'), 1925);
    await evaluate("click('短休 · 1 小时')"); assert.equal(await evaluate('model.readCurrentScene(ctx).clock.year'), 1925);
    assert.match(await evaluate('document.querySelector(".amin-result").textContent'), /1926-01-01 00:50/);
    await evaluate("click('确认应用一次')"); assert.equal(await evaluate('model.readCurrentScene(ctx).clock.year'), 1926);
    await evaluate("click('场景')"); await evaluate("fill('场景名称','客厅');fill('场景物件','窗户关闭');click('预览保存并进入')"); await evaluate("click('确认应用一次')");
    assert.equal(await evaluate('model.readCurrentScene(ctx).scenes[model.readCurrentScene(ctx).activeSceneId].name'), '客厅');
    await evaluate("click('设置')"); await evaluate("tick('允许正文与应用 AI 读取当前已确认资料');click('预览保存读取设置')"); await evaluate("click('确认应用一次')"); assert.match(await evaluate('model.currentPrompt(ctx)'), /窗户关闭/);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const label of ['时钟', '场景', '记录', '设置']) {
        await evaluate('click(' + JSON.stringify(label) + ')');
        const dimensions = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})'); assert.ok(dimensions.scroll <= dimensions.width, label + ' horizontal overflow ' + JSON.stringify(dimensions));
    }
    await evaluate("click('时钟')"); await evaluate("fill('原因','未提交草稿');ctx.chatMetadata={};ctx.getCurrentChatId=()=> 'another';(await import('/apps/scene/service.js')).getSharedSceneService().sync()");
    assert.equal(await evaluate('model.readCurrentScene(ctx).clock'), null);
    assert.equal(await evaluate('[...document.querySelectorAll("label")].find(el=>el.querySelector("span")?.textContent==="原因").querySelector("input").value'), '');
    assert.deepEqual(errors, []);
    console.log('PASS Chromium scene UI: empty state, preview/confirm, clock rollover, scene save/enter, opt-in prompt, chat switching, four tabs at 390px without overflow.');
    await evaluate('sceneView.dispose();sceneView.dispose()'); assert.equal(await evaluate('document.querySelectorAll(".amin-scene").length'), 0);
    await evaluate('sceneView=mountScene();sceneView.open()'); assert.equal(await evaluate('document.querySelectorAll(".amin-scene").length'), 1);
    await evaluate("sceneView.dispose();(await import('/apps/scene/service.js')).getSharedSceneService().dispose()");
    await send('Browser.close').catch(() => {});
} finally { clearTimeout(deadline); socket?.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
