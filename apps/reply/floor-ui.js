import {mount} from './workspace.js';
import {chatIdentity} from '../stylewriter/model.js';
import {mountFloorControl} from '../../settings/floor-layout.js';

export function floorContext(ctx,index,message){
 if(!Number.isInteger(index)||index<0||ctx.chat?.[index]!==message)throw Error('楼层内容已变化，请重新打开此窗口。');
 return {...ctx,chat:ctx.chat.slice(0,index+1)};
}
export function installReplyFloorButtons({rewriteOptions}={}){
 const getContext=()=>globalThis.SillyTavern?.getContext?.(),mounted=new Map(),owned=new Set();let serial=0,queued=false;
 const key=ctx=>chatIdentity(ctx??{});
 const node=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;};
 function attach(element){
  if(mounted.has(element))return mounted.get(element).dispose;
  const ctx=getContext(),index=Number(element.getAttribute('mesid')),message=ctx?.chat?.[index],chatKey=key(ctx);
  if(!message||message.is_system)return;
  const host=node('div','amin-reply-floor'),button=node('button','','✧ 回复选项');button.type='button';button.setAttribute('aria-expanded','false');button.title='参考至这一楼生成候选或改写草稿，仅填入当前输入框';
  let view=null,windowElement=null;
  const dock=mountFloorControl(element,'reply',host,button);
  function close(){view?.dispose();view=null;windowElement?.remove();windowElement=null;button.setAttribute('aria-expanded','false');dock.setOpen(false);}
  button.onclick=()=>{
   if(windowElement){close();return;}
   windowElement=node('section','amin-reply-floor-window');windowElement.setAttribute('aria-label','第 '+(index+1)+' 楼回复选项');
   const bar=node('header','amin-reply-floor-header'),title=node('strong','','回复选项 · 第 '+(index+1)+' 楼'),collapse=node('button','','收起');collapse.type='button';collapse.onclick=close;bar.append(title,collapse);
   const body=node('div','amin-reply-floor-body amin-ui');windowElement.append(bar,body);host.append(windowElement);
   body.append(node('p','amin-reply-floor-note','候选与参考文风只读取到这一楼；可在本窗口改写草稿，仅填入当前输入框，不会自动发送。'));
   try{view=mount(body,{rewriteOptions,instanceId:'amin-floor-reply-'+(++serial),headingText:'下一句怎么说',contextProvider:current=>{if(key(current)!==chatKey)throw Error('聊天已切换，请重新打开窗口。');return floorContext(current,index,message);}});if(!view)body.append(node('p','','请等待聊天输入框加载后重新打开。'));}
   catch(error){view?.dispose();view=null;body.append(node('p','',error.message));}
   button.setAttribute('aria-expanded','true');dock.setOpen(true);
  };
  const dispose=()=>{close();dock.dispose();mounted.delete(element);};mounted.set(element,{dispose,index,message,chatKey});return dispose;
 }
 const surface=globalThis.__TAURITAVERN__?.api?.chatSurface,managed=surface?.isManagedOwnershipRequired?.()===true;
 if(managed)surface.registerParticipant({id:'amin-os/reply-floor',protocolVersion:surface.protocolVersion,didMount:({element})=>{owned.add(element);attach(element);return ()=>{owned.delete(element);mounted.get(element)?.dispose();};}});
 function refresh(){const ctx=getContext();for(const [element,item]of mounted)if(!element.isConnected||item.chatKey!==key(ctx)||ctx?.chat?.[item.index]!==item.message||Number(element.getAttribute('mesid'))!==item.index)item.dispose();for(const element of managed?owned:document.querySelectorAll('#chat .mes[mesid]'))attach(element);}
 const schedule=()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;refresh();});}};
 if(!managed)new MutationObserver(schedule).observe(document.querySelector('#chat')??document.body,{childList:true,subtree:true});
 const ctx=getContext(),events=ctx?.eventTypes??ctx?.event_types??{};
 for(const name of ['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_UPDATED'])if(events[name])ctx.eventSource?.on(events[name],schedule);
 refresh();return {refresh};
}
