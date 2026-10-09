// Real Chromium + production UI/runtime/services, isolated in-memory host only.
// Does not touch installed chats, credentials, user services, or paid model APIs.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.env.AMIN_STORY_ARTIFACTS || path.resolve(root, '../../outputs/0.18.0-validation');
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'story-browser-profile-'));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>
html,body{margin:0;min-width:0;background:#202020;color:#eee;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}*{box-sizing:border-box}main{width:100%;max-width:900px;padding:12px;margin:auto}.amin-ui{--amin-bg:#202020;--amin-surface:#282828;--amin-control:#383838;--amin-text:#f3f3f3;--amin-muted:#b9c5cc;--amin-line:#666;--amin-accent:#0078d4;--amin-accent-text:#d7e8f5;--amin-ink:#fff;--amin-radius:0px;--amin-font:14px;--amin-space:12px}h1{font-size:22px;margin:0 0 12px}nav{display:flex;gap:8px;margin-bottom:12px}main>section{min-width:0}[hidden]{display:none!important}</style></head><body><main class="amin-ui"><h1>Amin os · 独立剧情资料</h1><nav><button id="storage-tab">剧情存储</button><button id="linkage-tab">联动更新</button></nav><p id="notice" role="status"></p><section id="storage"></section><section id="linkage" hidden></section></main></body></html>`;
const blockedRequests = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
  if (url.pathname.startsWith('/api/')) { blockedRequests.push(url.pathname); response.statusCode = 403; response.end('Model/host API forbidden'); return; }
  if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { response.statusCode = 403; response.end(); return; }
  try { response.setHeader('content-type', ({ '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' })[path.extname(file)] || 'text/javascript; charset=utf-8'); response.end(fs.readFileSync(file)); }
  catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new','--disable-gpu','--disable-extensions','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'], {stdio:['ignore','ignore','pipe'],windowsHide:true});
let browserStderr='';child.stderr.on('data',chunk=>browserStderr+=chunk.toString());
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { boundary:'Real headless Chromium, production Amin UI/runtime/services, isolated simulated host and memory extension store. No live user chat, Android device, remote API, or model proof.', checks:[], layouts:[], runtimeErrors:[], consoleErrors:[], blockedRequests };
let socket, sequence = 0, send, evaluate;
const pending = new Map();
async function fixture() {
  const data = new Map();
  window.__TAURITAVERN__ = {api:{extension:{store:{
    async tryGetJson({namespace,table,key}) {const k=[namespace,table,key].join('/');return data.has(k)?{found:true,value:structuredClone(data.get(k))}:{found:false};},
    async setJson({namespace,table,key,value}) {data.set([namespace,table,key].join('/'),structuredClone(value));}
  }}}};
  window.ctx = {characterId:0,characters:[{name:'测试向导',avatar:'fixture.png'}],chatId:'independent-browser',
    chat:[{name:'向导',is_user:false,mes:'艾琳走进城门。此正文在资料重置后保留。',swipe_id:0,extra:{}}],
    chatMetadata:{integrity:'isolated-story-browser',variables:{unrelated:'原有变量保留'}},extensionSettings:{},saved:0,
    getCurrentChatId(){return this.chatId;},async saveMetadata(){this.saved++;},saveMetadataDebounced(){this.saved++;},saveSettingsDebounced(){},setExtensionPrompt(){}
  };
  window.SillyTavern = {getContext:()=>ctx};
  const schema = await import('/apps/story-state/schema.js');
  const state = schema.emptyState();
  state.modules.characters = {version:1,characters:[{id:'pc-1',name:'艾琳',kind:'pc',notes:'浏览器隔离测试',stats:[]}]};
  ctx.chatMetadata[schema.KEY] = schema.validateState(state);
  window.bodyBefore = JSON.stringify(ctx.chat);
  window.runtime = (await import('/apps/state2/runtime.js')).initializeState2(()=>ctx);
  window.service = (await import('/apps/linkage/service.js')).createLinkageService(()=>ctx);
  await service.saveSettings({...service.settings(),enabled:true,mode:'review'});
  window.say = text => {document.getElementById('notice').textContent=text;};
  window.storageView = (await import('/settings/story-storage-view.js')).mountStoryStorage(document.getElementById('storage'),say,()=>runtime);
  window.linkageView = (await import('/apps/linkage/view.js')).mount(document.getElementById('linkage'),{api:service,getContext:()=>ctx,openStorySettings:()=>show('storage')});
  window.show = id => {for(const value of ['storage','linkage'])document.getElementById(value).hidden=value!==id;window.scrollTo(0,0);};
  for(const id of ['storage','linkage'])document.getElementById(id+'-tab').onclick=()=>show(id);
  window.visible = el => !el.closest('[hidden]') && !!el.getClientRects().length;
  window.click = async (id,label) => {const button=[...document.getElementById(id).querySelectorAll('button')].find(el=>visible(el)&&el.textContent.trim()===label);if(!button||button.disabled)throw Error('Missing/disabled '+label);button.scrollIntoView({block:'center'});button.click();await new Promise(resolve=>setTimeout(resolve,90));};
  return runtime.status();
}
async function waitFor(expression) {for(let n=0;n<100;n++){if(await evaluate(expression))return;await delay(40);}throw Error('Timed out: '+expression);}
async function capture(id,width,suffix='') {
  await send('Emulation.setDeviceMetricsOverride',{width,height:width<600?900:1100,deviceScaleFactor:1,mobile:width<600});
  await evaluate(`show(${JSON.stringify(id)})`); await delay(100);
  const layout=await evaluate(`(()=>{const p=document.getElementById(${JSON.stringify(id)});return {app:${JSON.stringify(id)},width:innerWidth,docWidth:document.documentElement.scrollWidth,client:p.clientWidth,scroll:p.scrollWidth,text:p.innerText,controls:[...p.querySelectorAll('button,select,textarea,input,summary')].filter(visible).map(el=>{const r=el.getBoundingClientRect();return {label:el.getAttribute('aria-label')||el.textContent.trim().slice(0,50),left:r.left,right:r.right,top:r.top,height:r.height,width:r.width,disabled:el.disabled||false};})};})()`);
  report.layouts.push(layout);
  assert.ok(layout.docWidth<=width+1 && layout.scroll<=layout.client+1,`Overflow ${id} ${width}: ${JSON.stringify(layout)}`);
  assert.ok(!layout.text.includes('�'),'UTF-8 text corruption');
  const invalid=layout.controls.filter(c=>c.left < -1 || c.right > width+1 || c.width<=0);
  assert.equal(invalid.length,0,'Controls outside viewport: '+JSON.stringify(invalid));
  if(width<600&&id==='storage')assert.ok(new Set(layout.controls.filter(c=>!c.disabled).map(c=>Math.round(c.top))).size>2,'Storage buttons did not wrap');
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(artifacts,`${id}-${width}${suffix}.png`),Buffer.from(shot.data,'base64'));
}
try {
  const file=path.join(profile,'DevToolsActivePort');for(let n=0;n<100&&!fs.existsSync(file);n++)await delay(100);
  assert.ok(fs.existsSync(file),'Edge failed to start');
  const port=fs.readFileSync(file,'utf8').split('\n')[0].trim();
  let pages,lastFetchError;for(let n=0;n<50&&!pages;n++){try{pages=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();}catch(error){lastFetchError=String(error.cause||error);await delay(100);}}
  assert.ok(pages,'Edge debugger HTTP endpoint failed to start: '+lastFetchError+'; exit='+child.exitCode+'; '+browserStderr);
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.id){const job=pending.get(value.id);pending.delete(value.id);clearTimeout(job?.timer);value.error?job?.reject(Error(JSON.stringify(value.error))):job?.resolve(value.result);}else if(value.method==='Runtime.exceptionThrown')report.runtimeErrors.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);else if(value.method==='Runtime.consoleAPICalled'&&value.params.type==='error')report.consoleErrors.push(value.params.args.map(a=>a.value||a.description).join(' '));};
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;};
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await waitFor('document.readyState==="complete"');
  const status=await evaluate('('+fixture.toString()+')()');assert.equal(status.mode,'independent');
  await waitFor('document.getElementById("storage").innerText.includes("已启用")');
  report.checks.push('Production independent runtime and linkage service mounted, without native variable engine');
  const linkedText=await evaluate('document.getElementById("linkage").textContent');
  assert.ok(linkedText.includes('当前剧情资料 · Amin 独立存储'));assert.ok(linkedText.includes('<amin_update>'));
  assert.ok(!/小白变量|<state>|重试恢复当前分支/.test(linkedText));
  await evaluate(`(async()=>{show('linkage');const mode=document.querySelector('[aria-label="模型更新方式"]');mode.value='auto';mode.dispatchEvent(new Event('change',{bubbles:true}));await click('linkage','保存联动设置');})()`);
  assert.equal(await evaluate('service.settings().mode'),'auto');report.checks.push('Browser mode select and Save button persist real service settings');
  await evaluate(`click('linkage','打开设置 → 剧情存储')`);assert.equal(await evaluate('document.getElementById("storage").hidden'),false);
  for(const width of [900,390,360])for(const id of ['storage','linkage'])await capture(id,width);
  await evaluate(`(async()=>{show('storage');await click('storage','备份并清空当前资料');})()`);
  assert.equal(await evaluate('runtime.exportState().state.modules.characters'),null);
  assert.equal(await evaluate('JSON.stringify(ctx.chat)===bodyBefore&&ctx.chatMetadata.variables.unrelated==="原有变量保留"'),true);
  await evaluate(`(async()=>{await click('storage','查看最近 5 份备份');await click('storage','预览所选备份');})()`);
  assert.equal(await evaluate('runtime.exportState().state.modules.characters'),null);
  await capture('storage',390,'-backup-preview');
  await evaluate(`click('storage','确认应用预览')`);
  assert.equal(await evaluate('runtime.exportState().state.modules.characters.characters[0].name'),'艾琳');
  report.checks.push('Real reset creates backup; read-only backup preview and explicit Apply restore character; original body/unrelated variables preserved');
  assert.deepEqual(report.runtimeErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(blockedRequests,[]);
  report.passed=true;
} catch(error) {report.passed=false;report.error=error.stack;process.exitCode=1;if(send){try{const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifacts,'browser-failure.png'),Buffer.from(shot.data,'base64'));}catch{}}}
finally {fs.writeFileSync(path.join(artifacts,'independent-story-browser-report.json'),JSON.stringify(report,null,2)+'\n');if(send){try{await send('Browser.close');}catch{}}socket?.close();child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify({passed:report.passed,checks:report.checks,layouts:report.layouts.map(({app,width,docWidth,client,scroll})=>({app,width,docWidth,client,scroll})),errors:report.error,artifacts},null,2));
