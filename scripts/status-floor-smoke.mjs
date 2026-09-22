// Real Edge DOM smoke tests with an isolated mock host; never reads real chat data.
// Run: node scripts/status-floor-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root = process.env.AMIN_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.AMIN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const artifacts = process.env.AMIN_STATUS_ARTIFACTS || path.resolve(root, '../status-browser-smoke');
if (!fs.existsSync(executable)) throw Error('Set AMIN_BROWSER to a Chromium executable.');
fs.mkdirSync(artifacts, {recursive:true});
const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'));
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/apps/status/style.css"><link rel="stylesheet" href="/style.css">
<style>html,body{margin:0;min-width:0;font:14px system-ui,sans-serif;background:#12191d;color:#edf3ef}*{box-sizing:border-box}#chat{max-width:1100px;margin:auto;padding:12px}.mes{margin:0 0 14px;min-width:0}.mes_text{padding:8px 0;color:#a2b2b7}.mes_block{min-width:0}#amin-os{position:static!important;inset:auto!important;max-width:100%;width:min(448px,100%);height:auto;min-height:0;margin:0 auto}#app{min-width:0;width:100%}[hidden]{display:none!important}</style>
</head><body><main id="chat"></main><div id="amin-os"><div id="app" class="amin-app-pane amin-ui" data-app="status"></div></div></body></html>`;
const routes = {
    '/scripts/variables.js': `export function setLocalVariable(key,value){const c=globalThis.SillyTavern.getContext();c.chatMetadata.variables??={};c.chatMetadata.variables[key]=value;c.writes.push({key,value,chatId:c.getCurrentChatId()});c.saveMetadataDebounced?.();}`,
    '/scripts/world-info.js': `export const selected_world_info=[];export const world_info={};export const world_names=[];export function loadWorldInfo(){throw Error('Unexpected real worldbook load in status fixture');}`,
};
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
    if (routes[url.pathname]) { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end(routes[url.pathname]); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.statusCode=403; response.end(); return; }
    try {
        const ext=path.extname(file);
        response.setHeader('content-type', ext==='.css'?'text/css':ext==='.html'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
        response.end(fs.readFileSync(file));
    } catch { response.statusCode=404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:'ignore',windowsHide:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errors=[], pending=new Map(), checks=[], layouts=[];
let socket, sequence=0;
let evaluate, send;
const fixture = async empty => evaluate(`(async()=>{
    const oldState={版本:1,项目:{玩家:{姓名:'旅人',金币:10,生命:{当前:8,最大:10}},世界:{地点:'旧港',天气:'晴'}}};
    const currentState={版本:1,项目:{玩家:{姓名:'旅人',金币:20,生命:{当前:9,最大:10}},世界:{地点:'星港观测站',天气:'微雨'}}};
    const history={records:{'m0:0':{state:oldState,savedAt:1},'m1:0':{state:currentState,savedAt:2}}};
    const listeners=new Map();window.listenerCount=()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0);
    window.ctx={characterId:0,groupId:null,characters:[{name:'长名称测试角色 · 星港旅人',avatar:'fixture.png',data:{description:'隔离浏览器测试'}}],
      chat:${empty?'[]':"[{name:'旅人',is_user:true,mes:'我走进旧港。',swipe_id:0,extra:{wsh_message_id:'m0'}},{name:'向导',is_user:false,mes:'你抵达星港观测站。',swipe_id:0,extra:{wsh_message_id:'m1'}}]"},
      chatMetadata:{variables:{状态栏:JSON.stringify(currentState),protected:'preserve'},world_status_hud_history_v1:history},
      extensionSettings:{world_status_hud_v1:{floorButtons:true}},currentChat:'fixture-a',writes:[],saved:0,
      getCurrentChatId(){return this.currentChat;},async saveMetadata(){this.saved++;},saveMetadataDebounced(){this.saved++;},async saveChat(){},saveSettingsDebounced(){},getRequestHeaders(){return {'Content-Type':'application/json'};},
      eventTypes:Object.fromEntries(['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_UPDATED','GENERATION_ENDED','CHARACTER_MESSAGE_RENDERED'].map(name=>[name,name])),
      eventSource:{on(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},off(name,callback){listeners.get(name)?.delete(callback);},emit(name){for(const callback of [...listeners.get(name)||[]])callback();}}};
    window.SillyTavern={getContext:()=>ctx};window.toastr={info(){},error(){},success(){}};window.confirm=()=>true;
    window.closeCount=0;window.click=async text=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===text&&!button.closest('[hidden]'));if(!button)throw Error('No visible button: '+text);return button.onclick?.();};
    window.paint=()=>{document.getElementById('chat').replaceChildren(...ctx.chat.map((message,index)=>{const floor=document.createElement('article');floor.className='mes';floor.setAttribute('mesid',index);const block=document.createElement('div');block.className='mes_block';const text=document.createElement('p');text.className='mes_text';text.textContent=(index+1)+' · '+message.name+'：'+message.mes;block.append(text);floor.append(block);return floor;}));};paint();
    const appearance=await import('/settings/appearance.js');appearance.initializeAppearance(()=>ctx);window.paintAppearance=appearance.installAppearance(document);
    window.statusModule=await import('/apps/status/index.js');window.app=statusModule.initialize({mount:document.getElementById('app'),onClose:()=>closeCount++});return true;
})()`);
async function waitFor(expression, label, timeout=7000) {
    const until=Date.now()+timeout;
    while (Date.now()<until) { if(await evaluate(expression)) return; await delay(40); }
    throw Error('Timed out: '+label+'; runtime errors: '+errors.join('\n'));
}
async function frameReady() {
    await waitFor("!!document.querySelector('.wsh-workbench iframe')?.contentDocument?.getElementById('mode')&&!document.querySelector('.wsh-workbench iframe').contentDocument.getElementById('mode').disabled",'state frame bridge');
}
async function navigate(empty=false, label='fixture') {
    console.log('Loading '+label+' fixture');
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?fixture='+label});
    await waitFor('document.readyState==="complete"&&!!document.getElementById("app")','fixture page');
    await fixture(empty);
}
async function recordLayout(width, height, label) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
    await evaluate("document.querySelector('.wsh-workbench')?.scrollIntoView({block:'start'});document.querySelector('.wsh-workbench iframe')?.contentWindow.scrollTo(0,0);window.paintAppearance.apply()");
    await delay(100);
    const layout = await evaluate(`(()=>{const panel=document.querySelector('.wsh-workbench'),frame=panel.querySelector('iframe'),rect=frame.getBoundingClientRect(),p=panel.getBoundingClientRect(),doc=frame.contentDocument;return {width:innerWidth,scroll:document.documentElement.scrollWidth,panel:{left:p.left,right:p.right,width:p.width,height:p.height},frame:{left:rect.left,right:rect.right,width:rect.width,height:rect.height},frameWidth:doc.documentElement.clientWidth,frameScroll:doc.documentElement.scrollWidth,tabs:panel.querySelectorAll('[role=tab]').length,tabRows:new Set([...panel.querySelectorAll('[role=tab]')].map(tab=>Math.round(tab.getBoundingClientRect().top))).size,buttonHeight:doc.getElementById('mode').getBoundingClientRect().height};})()`);
    layouts.push({label,...layout});
    const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(artifacts,label+'.png'),Buffer.from(screenshot.data,'base64'));
    assert.ok(layout.scroll<=width,`${label} page horizontal overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.panel.left>=-1&&layout.panel.right<=width+1,`${label} panel exceeds viewport: ${JSON.stringify(layout)}`);
    assert.ok(layout.frame.width>=180&&layout.frame.height>=145,`${label} unusable editor size: ${JSON.stringify(layout)}`);
    assert.ok(layout.frame.left>=layout.panel.left&&layout.frame.right<=layout.panel.right+1,`${label} iframe exceeds panel`);
    assert.ok(layout.frameScroll<=layout.frameWidth,`${label} frame horizontal overflow: ${JSON.stringify(layout)}`);
    assert.equal(layout.tabRows,1,`${label} tabs must stay on one scrollable row`);
    if(width<600)assert.ok(layout.buttonHeight>=43,`${label} touch control too small: ${JSON.stringify(layout)}`);
}
try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let n=0;n<100&&!fs.existsSync(portFile);n++)await delay(100);
    if(!fs.existsSync(portFile))throw Error('Edge debugger failed to start.');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
    const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(7000)})).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Debugger socket connection timeout')),7000);socket.onopen=()=>{clearTimeout(timer);resolve();};socket.onerror=event=>{clearTimeout(timer);reject(event.error||Error('Debugger socket failed'));};});
    socket.onmessage=event=>{
        const message=JSON.parse(event.data);
        if(message.id){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item?.timer);message.error?item?.reject(Error(JSON.stringify(message.error))):item?.resolve(message.result);}
        else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
    };
    send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Debugger timeout: '+method+' '+String(params.expression??'').slice(0,180)));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    await send('Runtime.enable');await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    await navigate();
    await waitFor("document.querySelectorAll('.wsh-floor-button').length===2",'both floor entries');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate('closeCount'),1);
    assert.equal(await evaluate("document.querySelectorAll('#app .wsh-workbench').length"),0);
    assert.equal(await evaluate("document.querySelectorAll('[mesid=\"1\"] .wsh-workbench').length"),1);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.wsh-workbench [role=tab]')].map(tab=>tab.textContent)"),['状态栏','生成设置','模板','状态规则','楼层记录','设置']);
    for(const tab of ['生成设置','模板','状态规则','楼层记录','设置','状态栏']){
        await evaluate('click('+JSON.stringify(tab)+')');
        assert.equal(await evaluate("document.querySelector('.wsh-workbench [role=tab][aria-selected=true]').textContent"),tab);
    }
    checks.push('app.open closes launcher and routes to the latest floor; all six tabs open');
    await evaluate("document.querySelector('[mesid=\"0\"] .wsh-floor-button').click()");
    assert.equal(await evaluate("document.querySelectorAll('[mesid=\"0\"] iframe').length"),0);
    assert.equal(await evaluate("document.querySelectorAll('[mesid=\"0\"] input,[mesid=\"0\"] textarea,[mesid=\"0\"] select').length"),0);
    assert.ok(await evaluate("document.querySelector('[mesid=\"0\"] .wsh-history').textContent.includes('旧港')"));
    assert.equal(await evaluate("JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.金币"),20);
    await evaluate("document.querySelector('[mesid=\"0\"] .wsh-open-current').click()");
    await waitFor("document.querySelectorAll('.wsh-workbench').length===1",'single current workbench');
    await frameReady();
    checks.push('old floor renders its own read-only snapshot and routes editing to current');

    await evaluate(`(()=>{const doc=document.querySelector('.wsh-workbench iframe').contentDocument;doc.getElementById('mode').click();const row=[...doc.querySelectorAll('.row')].find(row=>row.querySelector('.label')?.textContent==='金币');[...row.querySelectorAll('button')].find(button=>button.textContent==='编辑 / 改类型').click();doc.getElementById('value').value='37';doc.getElementById('form').requestSubmit();})()`);
    await waitFor("JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.金币===37",'iframe save current value');
    assert.equal(await evaluate("ctx.chatMetadata.world_status_hud_history_v1.records['m0:0'].state.项目.玩家.金币"),10);
    assert.equal(await evaluate("ctx.chatMetadata.world_status_hud_history_v1.records['m1:0'].state.项目.玩家.金币"),37);
    assert.equal(await evaluate('ctx.chatMetadata.variables.protected'),'preserve');
    await evaluate("document.querySelector('.wsh-workbench iframe').contentDocument.getElementById('mode').click()");
    checks.push('actual iframe editor saves current state and current snapshot; old snapshot and unrelated variables preserved');

    await recordLayout(1280,1000,'status-desktop');
    await recordLayout(390,844,'status-mobile-390');
    await recordLayout(320,740,'status-mobile-320');
    checks.push('1280px, 390px and 320px viewport: contained editor, no document/frame horizontal overflow, mobile controls >=44px');
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate('app.open("generate")');
    await evaluate("document.querySelector('.wsh-generation-form textarea').value='unfinished fixture draft'");
    await evaluate('app.open("state")');await frameReady();
    await evaluate('app.open("generate")');
    assert.equal(await evaluate("document.querySelector('.wsh-generation-form textarea').value"),'unfinished fixture draft');
    assert.equal(await evaluate("document.querySelectorAll('.wsh-workbench').length"),1);
    const listenerCount=await evaluate('listenerCount()');
    await evaluate("app=statusModule.initialize({mount:document.getElementById('app'),onClose:()=>closeCount++})");
    assert.equal(await evaluate('listenerCount()'),listenerCount);
    await evaluate('app.open("generate")');
    assert.equal(await evaluate("document.querySelectorAll('.wsh-workbench').length"),1);
    checks.push('repeated open changes tab without duplicate workbench and preserves generation draft');

    await evaluate('app.open("state")');await frameReady();
    const stale=await evaluate(`(async()=>{const frame=document.querySelector('.wsh-workbench iframe').contentWindow;ctx.chat.push({name:'旅人',is_user:true,mes:'继续前进',swipe_id:0,extra:{wsh_message_id:'m2'}});try{await frame.STscript('/setvar key=状态栏 '+JSON.stringify({项目:{玩家:{金币:999}}}));return 'unexpected write';}catch(error){return error.message;}})()`);
    assert.match(stale,/楼层已变化/);
    assert.equal(await evaluate("JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.金币"),37);
    await evaluate("paint();ctx.eventSource.emit('MESSAGE_SENT')");
    await waitFor("document.querySelectorAll('.wsh-workbench').length===0&&document.querySelectorAll('.wsh-floor-button').length===3",'new message cleanup');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate("document.querySelectorAll('[mesid=\"2\"] .wsh-workbench').length"),1);
    await evaluate("ctx.chat[2].swipe_id=1;ctx.eventSource.emit('MESSAGE_SWIPED')");
    await waitFor("document.querySelectorAll('.wsh-workbench').length===0",'swipe cleanup');
    await evaluate('app.open()');await frameReady();
    checks.push('stale iframe write rejected after new message; old workbench closes and latest floor reopens; swipe closes old variant');

    await evaluate("window.oldMetadata=ctx.chatMetadata;ctx.currentChat='fixture-b';ctx.chatMetadata={variables:{状态栏:JSON.stringify({版本:1,项目:{玩家:{金币:77}}}),protected:'new-chat'}};ctx.chat=[{name:'另一角色',is_user:false,mes:'第二个聊天',swipe_id:0,extra:{wsh_message_id:'b0'}}];paint();ctx.eventSource.emit('CHAT_CHANGED')");
    await waitFor("document.querySelectorAll('.wsh-workbench').length===0&&document.querySelectorAll('.wsh-floor-button').length===1",'chat switch cleanup');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate("JSON.parse(ctx.chatMetadata.variables.状态栏).项目.玩家.金币"),77);
    assert.equal(await evaluate("JSON.parse(oldMetadata.variables.状态栏).项目.玩家.金币"),37);
    assert.equal(await evaluate("document.querySelectorAll('.wsh-generation-form').length"),1);
    checks.push('chat switch removes stale panels; reopening reads only the new chat');

    await navigate(false,'reload');
    await waitFor("document.querySelectorAll('.wsh-floor-button').length===2",'reload floor controls');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate("document.querySelectorAll('.wsh-workbench').length"),1);
    checks.push('fresh page reload initializes one workbench and one control per floor');

    await navigate(true,'empty');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate("document.querySelectorAll('#app .wsh-workbench[data-empty-chat=true]').length"),1);
    assert.equal(await evaluate("document.querySelectorAll('.wsh-floor-button').length"),0);
    await evaluate("ctx.chat.push({name:'旅人',is_user:true,mes:'第一条消息',swipe_id:0,extra:{wsh_message_id:'e0'}});ctx.eventSource.emit('MESSAGE_SENT')");
    await delay(80);
    assert.equal(await evaluate("document.querySelectorAll('#app .wsh-workbench').length"),1,'empty fallback must survive until first message DOM arrives');
    await evaluate("paint();ctx.eventSource.emit('CHARACTER_MESSAGE_RENDERED')");
    await waitFor("document.querySelectorAll('#app .wsh-workbench').length===0&&document.querySelectorAll('.wsh-floor-button').length===1",'empty fallback retirement');
    await evaluate('app.open()');await frameReady();
    assert.equal(await evaluate("document.querySelectorAll('[mesid=\"0\"] .wsh-workbench').length"),1);
    checks.push('empty chat supports editor fallback and migrates to first message floor');
    assert.deepEqual(errors,[],'uncaught browser runtime exceptions');
    fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,checks,layouts,runtimeErrors:errors},null,2));
    console.log('PASS status floor integration: '+checks.join('; ')+'.');
    console.log('Artifacts: '+artifacts);
    await send('Browser.close').catch(()=>{});
} catch(error) {
    fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,error:String(error),checks,layouts,runtimeErrors:errors},null,2));
    throw error;
} finally {
    socket?.close();child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
