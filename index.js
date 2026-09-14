import {installReplyFloorButtons} from './apps/reply/floor-ui.js';
import {initializeAppearance,installAppearance} from './settings/appearance.js';
import {initializeAI} from './ai/service.js';
import { createShell } from './shell.js';

let instance;
export function initialize() {
    if(instance)return instance;
    const ctx=globalThis.SillyTavern?.getContext?.();
    if(!ctx?.extensionSettings)return;
    const existing = [];
    if(globalThis.SillyTavernDynamicMap || document.querySelector('.dynamic-map-panel'))existing.push('动态地图');
    if(document.getElementById('wsh-launcher'))existing.push('世界状态栏');
    if(document.getElementById('reply-options-panel'))existing.push('回复选项');
    initializeAppearance(()=>globalThis.SillyTavern?.getContext?.());
    const shell=createShell();
    installAppearance(document);
    instance=shell;
    if(existing.length){
        shell.setBlocked(`检测到旧插件：${existing.join('、')}。请在扩展管理中停用这三个旧插件，然后刷新页面，再使用 Amin os。已有数据会保留。`);
        return shell;
    }
    ctx.extensionSettings.dynamicMapNamespace ||= crypto.randomUUID();
    ctx.saveSettingsDebounced?.();
    initializeAI(localStorage,ctx.extensionSettings.dynamicMapNamespace);
    const apps={
        information:()=>import('./apps/information/view.js').then(m=>m.mount(shell.panes.information)),
        effects:()=>import('./apps/effects/view.js').then(m=>m.mount(shell.panes.effects)),
        settings:()=>import('./settings/view.js').then(m=>m.mount(shell.panes.settings)),
        ai:()=>import('./ai/view.js').then(m=>m.mount(shell.panes.ai)),
        map:()=>import('./apps/map/index.js').then(m=>m.initialize({mount:shell.panes.map,onOpen:()=>shell.showApp('map')})),
        status:()=>import('./apps/status/index.js').then(m=>m.initialize({mount:shell.panes.status,onClose:()=>shell.home()})),
        reply:()=>import('./apps/reply/index.js').then(m=>{m.mount({target:shell.panes.reply});return {open(){if(!shell.panes.reply.querySelector('#reply-options-panel'))m.mount({target:shell.panes.reply});if(!shell.panes.reply.querySelector('#reply-options-panel'))throw Error('请等待聊天输入框加载完成后重试。');}};}),
    };
    const ready={};
    for(const id of Object.keys(apps)){
        // Initialize background listeners once, even while the shell is collapsed.
        ready[id]=apps[id]().then(value=>({value}),error=>({error}));
        shell.register(id,async()=>{
            let result=await ready[id];
            if(result.error){ready[id]=apps[id]().then(value=>({value}),error=>({error}));result=await ready[id];}
            if(result.error)throw result.error;
            await result.value?.open?.();
        });
    }
    installReplyFloorButtons();
    const ev=ctx.eventTypes??ctx.event_types??{};
    if(ev.CHAT_CHANGED)ctx.eventSource?.on(ev.CHAT_CHANGED,()=>queueMicrotask(()=>shell.refreshActive()));
    globalThis.AminOS=Object.freeze({version:'0.7.2',open:()=>shell.open(),openApp:id=>shell.showApp(id),close:()=>shell.close()});
    return shell;
}

function start(){
    const ctx=globalThis.SillyTavern?.getContext?.(),ev=ctx?.eventTypes??ctx?.event_types??{};
    for(const key of ['APP_INITIALIZED','APP_READY'])if(ev[key])ctx.eventSource?.on(ev[key],initialize);
    initialize();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
