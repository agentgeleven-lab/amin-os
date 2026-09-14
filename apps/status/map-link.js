globalThis.WorldStatusHudMapBridge={version:1};
// Optional dynamic-map UI; never writes the status variable or historical records.
export function createMapLink({check=()=>{},open=()=>{},getApi=()=>globalThis.SillyTavernDynamicMap,interval=750}){
 const element=document.createElement('section');element.className='wsh-map-link';element.setAttribute('aria-label','当前位置地图');
 const title=document.createElement('strong'),text=document.createElement('p'),button=document.createElement('button');title.textContent='🗺 当前地图位置';button.type='button';button.className='menu_button';button.textContent='打开当前位置地图';element.append(title,text,button);
 function refresh(){try{check();const api=getApi(),status=api?.getIntegrationStatus?.(),summary=api?.getIntegrationSummary?.();element.hidden=status?.hud===false;button.disabled=!summary;text.textContent=summary?(summary.位置路径||'当前位置未设置')+(summary.行政归属?' · '+summary.行政归属:''):api?'请先在地图插件中保存聊天地图':'未检测到动态地图插件';}catch{button.disabled=true;text.textContent='聊天已切换，请重新打开状态栏';}}
 button.onclick=()=>{try{check();const api=getApi();if(!api?.getIntegrationSummary?.())return;open();api.openCurrentLocation?.();}catch(e){text.textContent=e.message;}};
 refresh();const timer=interval?setInterval(refresh,interval):null;
 return {element,refresh,destroy(){if(timer)clearInterval(timer);element.remove();}};
}
