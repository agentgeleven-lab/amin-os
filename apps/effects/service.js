import {KEY,readStore,anchor,compile} from './model.js';
export const PROMPT_KEY='amin-os-persistent-effects';
export function createEffects(getContext){
 let busy=false,message='尚未发送提醒';const listeners=new Set();
 const notify=()=>listeners.forEach(f=>f());
 function clear(){getContext()?.setExtensionPrompt?.(PROMPT_KEY,'',1,0,false);}
 function identity(c){return String(c?.groupId??'')+' / '+String(c?.getCurrentChatId?.()??'');}
 function capture(){const c=getContext();if(!c?.chatMetadata||c.getCurrentChatId?.()==null)throw Error('请先打开一个聊天');return {meta:c.chatMetadata,id:identity(c),path:JSON.stringify(anchor(c.chat))};}
 function check(token){const c=getContext();if(token.meta!==c?.chatMetadata||token.id!==identity(c)||token.path!==JSON.stringify(anchor(c.chat)))throw Error('聊天或楼层已变化，请重新打开表单');return c;}
 async function save(token,update){
  if(busy)throw Error('正在保存，请稍候');const c=check(token);if(typeof c.saveMetadata!=='function')throw Error('当前酒馆缺少聊天保存接口');
  const before=c.chatMetadata[KEY],next=update(readStore(c));busy=true;
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
 return {capture,check,save,read:()=>readStore(getContext()),context:getContext,status:()=>supported?message:'当前前端缺少持续提示接口；可管理记录并复制预览',supported,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){clear();for(const [event,fn]of Object.entries(handlers))if(events[event])source?.removeListener?.(events[event],fn);}};
}
