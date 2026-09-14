import {KEY,read,path,compile,LIBRARY_KEY,library,archive} from './model.js';
export const PROMPT_KEY='amin-os-information-panel';
export function createInformation(context){
 let busy=false,message='尚未注入剧情提醒';const listeners=new Set();const notify=()=>listeners.forEach(fn=>fn());
 const identity=c=>JSON.stringify([c?.groupId??null,c?.characters?.[c.characterId]?.avatar??null,c?.getCurrentChatId?.()]);
 function capture(){const c=context();if(!c?.chatMetadata||c.getCurrentChatId?.()==null)throw Error('请先打开一个聊天');return {meta:c.chatMetadata,identity:identity(c),path:JSON.stringify(path(c.chat)),revision:c.chatMetadata[KEY]};}
 function check(t){const c=context();if(t.meta!==c?.chatMetadata||t.identity!==identity(c)||t.path!==JSON.stringify(path(c.chat))||t.revision!==c.chatMetadata[KEY])throw Error('聊天、楼层或面板记录已变化，请重新打开面板后操作');return c;}
 function clear(){context()?.setExtensionPrompt?.(PROMPT_KEY,'',1,0,false);}
 async function save(token,update,updateLibrary){if(busy)throw Error('正在保存，请稍候');const c=check(token);if(!c.saveMetadata)throw Error('当前前端缺少聊天保存接口');const old=c.chatMetadata[KEY],oldLibrary=c.chatMetadata[LIBRARY_KEY],next=update(read(c)),nextLibrary=updateLibrary?updateLibrary(library(c),next):oldLibrary;busy=true;c.chatMetadata[KEY]=next;if(updateLibrary)c.chatMetadata[LIBRARY_KEY]=nextLibrary;
  try{await c.saveMetadata();clear();message='已保存，后续剧情采用已确认的设定';}catch(e){c.chatMetadata[KEY]=old;if(updateLibrary)c.chatMetadata[LIBRARY_KEY]=oldLibrary;message='保存失败：'+e.message;throw e;}finally{busy=false;notify();}
 }
 async function saveRecord(token,record,search){
  if(busy)throw Error('正在保存，请稍候');const c=check(token);if(!c.saveMetadata)throw Error('当前前端缺少聊天保存接口');const old=c.chatMetadata[LIBRARY_KEY];busy=true;c.chatMetadata[LIBRARY_KEY]=archive(library(c),record,search);
  try{await c.saveMetadata();message='资料已收纳，不影响正文';}catch(e){c.chatMetadata[LIBRARY_KEY]=old;throw e;}finally{busy=false;notify();}
 }
 function start(type='normal',params={},dry=false){clear();if(dry||params?.signal?.aborted||!['normal','continue','regenerate','swipe'].includes(type))return;try{if(busy)throw Error('信息面板正在保存，本轮未注入');const c=context();let chat=c.chat??[];if(['regenerate','swipe'].includes(type)&&chat.length&&!chat.at(-1).is_user)chat=chat.slice(0,-1);const text=compile(read(c),chat);c.setExtensionPrompt(PROMPT_KEY,text,1,0,false);message=text?'已附加当前信息面板设定':'没有需要附加的已确认设定';}catch(e){message=e.message;}notify();}
 const c=context(),events=c.eventTypes??c.event_types??{},source=c.eventSource,supported=!!(source?.on&&c.setExtensionPrompt&&events.GENERATION_AFTER_COMMANDS&&events.CHAT_CHANGED);
 const handlers={GENERATION_AFTER_COMMANDS:start,GENERATION_ENDED:clear,GENERATION_STOPPED:clear,CHAT_CHANGED:()=>{clear();message='已切换聊天';notify();},MESSAGE_DELETED:clear,MESSAGE_UPDATED:clear,MESSAGE_SWIPED:clear};
 if(supported)for(const [key,fn]of Object.entries(handlers))if(events[key])source.on(events[key],fn);
 return {context,capture,check,save,saveRecord,library:()=>library(context()),read:()=>read(context()),status:()=>supported?message:'当前前端缺少自动提示接口，可编辑面板并查看提示预览',subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){clear();for(const [key,fn]of Object.entries(handlers))if(events[key])source?.removeListener?.(events[key],fn);}};
}

let sharedService;
export const getSharedService=()=>sharedService??= createInformation(()=>globalThis.SillyTavern?.getContext?.());
