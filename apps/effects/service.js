import {KEY,readStore,anchor,compile} from './model.js';
import {LIBRARY_KEY,mergeLibrary} from './library.js';
export const PROMPT_KEY='amin-os-persistent-effects';
export function createEffects(getContext){
 let busy=false,message='尚未发送提醒';const listeners=new Set();
 const notify=()=>listeners.forEach(f=>f());
 function clear(){getContext()?.setExtensionPrompt?.(PROMPT_KEY,'',1,0,false);}
 function identity(c){return String(c?.groupId??'')+' / '+String(c?.getCurrentChatId?.()??'');}
 function capture(){const c=getContext();if(!c?.chatMetadata||c.getCurrentChatId?.()==null)throw Error('请先打开一个聊天');return {meta:c.chatMetadata,id:identity(c),path:JSON.stringify(anchor(c.chat)),library:JSON.stringify(readStore(c).skills)};}
 function check(token){const c=getContext();if(token.meta!==c?.chatMetadata||token.id!==identity(c)||token.path!==JSON.stringify(anchor(c.chat)))throw Error('聊天或楼层已变化，请重新打开表单');if(token.library!==JSON.stringify(readStore(c).skills))throw Error('共享能力库已变化，请重新打开表单');return c;}
 function migrate(c){
  if(!c?.extensionSettings||typeof c.saveSettingsDebounced!=='function')return;
  const before=c.extensionSettings[LIBRARY_KEY],next=mergeLibrary(before,c.chatMetadata?.[KEY]?.skills??[]);
  if(JSON.stringify(before)===JSON.stringify(next))return;
  c.extensionSettings[LIBRARY_KEY]=next;
  try{const pending=c.saveSettingsDebounced();pending?.catch?.(e=>{if(c.extensionSettings[LIBRARY_KEY]===next)c.extensionSettings[LIBRARY_KEY]=before;message='旧能力迁移保存失败：'+e.message;notify();});}catch(e){c.extensionSettings[LIBRARY_KEY]=before;throw e;}
 }
 function read(){const c=getContext();readStore(c);migrate(c);return readStore(c);}
 async function saveLibrary(token,update){
  if(busy)throw Error('正在保存，请稍候');const c=check(token);
  if(!c.extensionSettings||typeof c.saveSettingsDebounced!=='function')throw Error('当前酒馆缺少全局设置保存接口');
  migrate(c);const before=c.extensionSettings[LIBRARY_KEY],store=readStore(c),events=JSON.stringify(store.events),next=update(store);
  if(JSON.stringify(next.events)!==events)throw Error('能力库不能修改聊天生效记录');
  const library={...before,skills:structuredClone(next.skills)};busy=true;c.extensionSettings[LIBRARY_KEY]=library;
  try{await c.saveSettingsDebounced();message='能力库已保存，所有角色和聊天共享；已发动效果保持原规则';}
  catch(e){if(c.extensionSettings[LIBRARY_KEY]===library)c.extensionSettings[LIBRARY_KEY]=before;message='能力库保存失败：'+e.message;throw e;}
  finally{busy=false;notify();}
 }
 async function save(token,update){
  if(busy)throw Error('正在保存，请稍候');const c=check(token);if(typeof c.saveMetadata!=='function')throw Error('当前酒馆缺少聊天保存接口');
  migrate(c);const before=c.chatMetadata[KEY],next=update(readStore(c));busy=true;
  if(c.extensionSettings?.[LIBRARY_KEY])next.skills=structuredClone(before?.skills??[]);
  c.chatMetadata[KEY]=next;
  try{await c.saveMetadata();clear();message='已保存，下次生成时使用当前记录';}
  catch(e){c.chatMetadata[KEY]=before;message='保存失败：'+e.message;throw e;}
  finally{busy=false;notify();}
 }
 function start(type='normal',params={},dry=false){
  clear();if(dry||!['normal','regenerate','swipe','continue'].includes(type)||params?.signal?.aborted)return;
  try{if(busy)throw Error('持续效果正在保存，本轮未附加提醒');const ctx=getContext();let chat=ctx.chat??[];
   // Some hosts emit this event before removing the assistant reply being replaced.
   if(['regenerate','swipe'].includes(type)&&chat.length&&!chat.at(-1).is_user)chat=chat.slice(0,-1);
   const prompt=compile(readStore(ctx),chat);ctx.setExtensionPrompt(PROMPT_KEY,prompt,1,0,false);message=prompt?`已附加 ${prompt.length} 字符持续效果提醒`:'当前没有启用的生效记录';}
  catch(e){message=e.message;}notify();
 }
 const ctx=getContext(),events=ctx.eventTypes??ctx.event_types??{},source=ctx.eventSource;
 const supported=!!(ctx.setExtensionPrompt&&source?.on&&events.GENERATION_AFTER_COMMANDS&&events.CHAT_CHANGED);
 const handlers={GENERATION_AFTER_COMMANDS:start,CHAT_CHANGED:()=>{clear();message='已切换聊天';notify();},GENERATION_ENDED:clear,GENERATION_STOPPED:clear,MESSAGE_DELETED:()=>{clear();notify();},MESSAGE_SWIPED:()=>{clear();notify();},MESSAGE_UPDATED:()=>{clear();notify();}};
 if(supported)for(const [event,fn]of Object.entries(handlers))if(events[event])source.on(events[event],fn);
 return {capture,check,save,saveLibrary,read,context:getContext,status:()=>supported?message:'当前前端缺少持续提示接口；可管理记录并复制预览',supported,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){clear();for(const [event,fn]of Object.entries(handlers))if(events[event])source?.removeListener?.(events[event],fn);}};
}

let sharedService;
export const getSharedService=()=>sharedService??= createEffects(()=>globalThis.SillyTavern?.getContext?.());
