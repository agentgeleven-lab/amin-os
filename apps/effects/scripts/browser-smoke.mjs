// Dependency-free Edge/Chromium smoke test for the ability app.
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-abilities-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/ui/standard.css"><link rel="stylesheet" href="/apps/reply/style.css"><link rel="stylesheet" href="/settings/appearance.css"><style>body{margin:0;font:14px sans-serif;background:#202020;color:#fff;--amin-card:#292929;--amin-line:#666;--amin-text:#fff;--amin-muted:#ccc;--amin-gap:10px;--amin-font:13px;--amin-radius:6px;--amin-control:#333;--amin-accent:#7bbad3;--amin-ink:#111}*{box-sizing:border-box}#app{width:448px;max-width:100%;padding:10px}button,input,select,textarea{font:inherit}textarea,input,select{width:100%}</style></head><body><div id="amin-os"><div id="app" class="amin-ui"></div></div><form id="send_form"><textarea id="send_textarea" placeholder="发送消息…"></textarea></form></body></html>`;
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

    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    for(const managed of [false,true]){
        if(managed){
            await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
            for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("app") && !window.SillyTavern'))break;await delay(50);}
        }
        const result=await evaluate(`import('/apps/effects/scripts/browser-checks.js').then(m=>m.runAbilityChecks({managed:${managed}}))`);
        assert.deepEqual(errors,[]);console.log('PASS ability Chromium '+(managed?'managed':'standard')+': '+result.checks);
    }
    await send('Browser.close').catch(()=>{});
}finally{
    socket?.close();child.kill();await new Promise(resolve=>server.close(resolve));
}
