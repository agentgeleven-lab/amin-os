import {KEY,emptyState,createManager} from './service.js';
import {createHost} from './host.js';
let shared;
export async function getManager(){
 if(shared)return shared;
 shared=(async()=>{
  const context=()=>globalThis.SillyTavern.getContext(),ctx=context();
  const wi=await import('/scripts/world-info.js');
  const recoveryKey=KEY+':'+ctx.extensionSettings.dynamicMapNamespace;
  let initial=ctx.extensionSettings[KEY]??emptyState();
  try{const recovered=JSON.parse(localStorage.getItem(recoveryKey));if(recovered?.version===1)initial=recovered;}catch{}
  const manager=createManager({host:createHost(wi,context),context,initial,persist(state){
   // Synchronous journal first: a reload between host writes must not lose ownership.
   localStorage.setItem(recoveryKey,JSON.stringify(state));
   context().extensionSettings[KEY]=state;context().saveSettingsDebounced?.();
  }});
  const ev=ctx.eventTypes??ctx.event_types??{};
  if(ev.CHAT_CHANGED)ctx.eventSource?.on(ev.CHAT_CHANGED,()=>manager.sync().catch(()=>{}));
  await manager.sync().catch(()=>{});return manager;
 })().catch(e=>{shared=null;throw e;});
 return shared;
}
