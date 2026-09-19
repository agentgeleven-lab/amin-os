// Dependency-free Edge/Chromium smoke test. Uses isolated fixture data, never real chat storage.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=process.env.AMIN_REPO||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const executable=process.env.AMIN_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if(!fs.existsSync(executable))throw Error('Set AMIN_BROWSER to a Chromium executable');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'amin-org-browser-'));
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui/standard.css"><style>body{margin:0;font:14px sans-serif;background:#202020;color:white;--amin-card:#292929;--amin-line:#666;--amin-text:white;--amin-muted:#ccc;--amin-gap:10px;--amin-font:13px;--amin-radius:6px;--amin-control:#333;--amin-accent:#7bbad3;--amin-ink:#111}#app{width:448px;max-width:100%;box-sizing:border-box;padding:10px}button,input,select,textarea{font:inherit}textarea{width:100%}</style></head><body><div id="amin-os"><div id="app" class="amin-ui"></div></div></body></html>`;
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)){res.statusCode=403;res.end();return;}try{res.setHeader('content-type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let socket;const errors=[];const pending=new Map();let seq=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(portFile);i++)await delay(100);
 if(!fs.existsSync(portFile))throw Error('Browser debugger failed to start');const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+':'+(m.params.exceptionDetails.exception?.description??''));};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
 for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("app")'))break;await delay(50);}
 await evaluate(`(async()=>{
 const {harness}=await import('/apps/organizations/test/fixtures.js');const {mount}=await import('/apps/organizations/view.js');
 window.h=harness();window.confirm=()=>true;h.ctx.characters[0].data.extensions={world:'bound'};window.bookRevision='first';window.bookReads=[];window.aiRequests=[];window.sources={loadWorldInfo:async()=>({selected_world_info:['global','bound'],world_info:{},world_names:['global','bound','not-enabled']}),readBook:async name=>{bookReads.push(name);return {entries:{a:{content:name+':'+bookRevision,key:['unmatched'],probability:0},b:{content:'disabled',disable:true}}};}};
 window.fakeAI={capture:()=>({}),generate:async(task,ctx,req)=>{const request=JSON.parse(req.prompt);aiRequests.push(request);if(request.operation==='assessment')return JSON.stringify({title:'观察榜',criteria:'影响力',summary:'分析',limitations:'资料有限',rows:[{group:'organizations',id:'a',rank:1,assessment:'较强',basis:'资料',strengths:'行政',weaknesses:'未知',confidence:'一般'}]});const d=h.api.read();d.summary='AI当前局势';return JSON.stringify(d);}};
 window.view=await mount(document.getElementById('app'),{api:h.api,ai:()=>fakeAI,sourceOptions:sources});window.mountAgain=()=>mount(document.getElementById('app'),{api:h.api,ai:()=>fakeAI,sourceOptions:sources});
 window.click=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error('button not found: '+text);await b.onclick();};
 window.input=label=>document.querySelector('[aria-label="'+label+'"]');
 return true;
})()`);
 for(let i=0;i<4;i++){await evaluate("click('组织')");await evaluate("click('地区')");await evaluate("click('总览')");}
 assert.equal(await evaluate("document.querySelectorAll('[role=tab]').length"),6);
 assert.equal(await evaluate("document.querySelectorAll('.amin-organizations').length"),1);
 await evaluate("click('组织')");await evaluate("click('编辑资料')");await evaluate("input('名称').value='草稿共和国';h.api.sync()");assert.equal(await evaluate("input('名称').value"),'草稿共和国');
 await evaluate("click('取消')");assert.equal(await evaluate("h.api.read().organizations.a.name"),'共和国');
 await evaluate("click('编辑资料')");await evaluate("input('名称').value='新共和国'");await evaluate("click('预览保存')");assert.equal(await evaluate("h.api.read().organizations.a.name"),'共和国');await evaluate("click('确认应用')");assert.equal(await evaluate("h.api.read().organizations.a.name"),'新共和国');
 await evaluate("click('锁定字段')");await evaluate("[...document.querySelectorAll('label')].find(l=>l.firstChild.textContent==='名称').querySelector('input').checked=true");await evaluate("click('保存锁定设置')");assert.ok((await evaluate('h.api.locks()')).includes('organizations.a.name'));
 await evaluate("click('按当前剧情更新')");assert.equal(await evaluate('h.api.read().summary'),'');await evaluate("click('放弃结果')");assert.equal(await evaluate('h.api.pending()'),null);
 await evaluate("click('按当前剧情更新')");await evaluate("click('确认应用')");assert.equal(await evaluate('h.api.read().summary'),'AI当前局势');assert.equal(await evaluate('h.api.pending()'),null);
 await evaluate("click('评估排行')");await evaluate("click('生成／刷新AI评估')");await evaluate("click('确认应用')");assert.equal(await evaluate('h.api.assessment().title'),'观察榜');assert.equal(await evaluate("h.ctx.chatMetadata.variables['势力资料'].includes('观察榜')"),false);
 await evaluate("click('生成与规则')");await evaluate("input('整理范围').value='只整理港口'");await evaluate("click('保存生成与规则设置')");assert.equal(await evaluate('h.api.config().scope'),'只整理港口');
 await evaluate("click('生成与规则')");assert.equal(await evaluate("input('是否读取世界书').checked"),true);assert.equal(await evaluate("document.querySelectorAll('[data-worldbook]').length"),2);assert.equal(await evaluate("document.querySelector('[data-worldbook=bound]').disabled"),true);
 await evaluate("(()=>{const i=document.querySelector('[data-worldbook=global]');i.checked=true;i.onchange();})()");await evaluate("click('保存生成与规则设置')");assert.deepEqual(await evaluate('h.api.config().selectedBooks'),['global']);
 await evaluate("bookRevision='second';click('重新生成整套')");assert.ok((await evaluate('aiRequests.at(-1).sources.worldbooks')).every(b=>b.entries[0].content.endsWith('second')));await evaluate("click('放弃结果')");
 await evaluate("bookRevision='third';click('按当前剧情更新')");assert.ok((await evaluate('aiRequests.at(-1).sources.worldbooks')).every(b=>b.entries[0].content.endsWith('third')));await evaluate("click('放弃结果')");
 await evaluate("click('生成与规则')");await evaluate("input('是否读取世界书').checked=false;input('是否读取世界书').onchange()");await evaluate("click('保存生成与规则设置')");const readsBefore=await evaluate('bookReads.length');await evaluate("click('按当前剧情更新')");assert.equal(await evaluate('bookReads.length'),readsBefore);assert.deepEqual(await evaluate('aiRequests.at(-1).sources.worldbooks'),[]);assert.ok(await evaluate('!!aiRequests.at(-1).sources.character'));await evaluate("click('放弃结果')");
 await evaluate("click('生成与规则')");assert.equal(await evaluate("input('是否读取世界书').checked"),false);assert.equal(await evaluate("document.querySelector('[data-worldbook=global]').checked"),true);await evaluate("click('取消')");
 await evaluate("click('总览')");await evaluate("click('第1楼 · 角色')");assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='按当前剧情更新')"),false);await evaluate("click('组织')");assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='编辑资料')"),false);await evaluate("click('返回当前资料')");
 await evaluate('mountAgain()');await evaluate('view.open()');assert.equal(await evaluate("document.querySelectorAll('.amin-organizations').length"),1);assert.equal(await evaluate("document.querySelectorAll('[role=tab]').length"),6);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate("click('组织')");
 const layout=await evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})');assert.equal(layout.width,390);assert.ok(layout.scroll<=layout.width,'narrow page overflows: '+JSON.stringify(layout));
 if(process.env.AMIN_SCREENSHOT){const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.mkdirSync(path.dirname(process.env.AMIN_SCREENSHOT),{recursive:true});fs.writeFileSync(process.env.AMIN_SCREENSHOT,Buffer.from(shot.data,'base64'));}
 assert.deepEqual(errors,[]);console.log('PASS real Chromium DOM: repeated tabs/mount, draft preservation, edit/preview/confirm/cancel, locks, AI updates, private assessments, rules, historical read-only, 390px layout.');
 await evaluate('h.api.dispose()');await send('Browser.close').catch(()=>{});
}finally{socket?.close();child.kill();await new Promise(r=>server.close(r));}
