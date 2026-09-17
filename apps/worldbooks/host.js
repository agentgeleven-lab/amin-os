export function createHost(wi,context,{request=globalThis.fetch,jquery=globalThis.jQuery}={}){
 const baselines=new WeakMap();
 const globals=()=>[...(wi.selected_world_info??[])];
 return {
  globals,
  async names(){if(!Array.isArray(wi.world_names))throw Error('酒馆尚未提供世界书列表，请稍后刷新');return [...wi.world_names];},
  async load(name){const data=await wi.loadWorldInfo(name);if(!data?.entries)throw Error(`无法读取世界书：${name}，恢复记录已保留`);const copy=structuredClone(data);baselines.set(copy,JSON.stringify(data));return copy;},
  async setGlobal(name,enabled){
   const next=globals().filter(x=>x!==name);if(enabled)next.push(name);
   if(JSON.stringify(next)===JSON.stringify(globals()))return;
   if(typeof wi.updateWorldInfoSettings==='function')wi.updateWorldInfoSettings({},next);
   else if(Array.isArray(wi.selected_world_info)&&wi.world_info){wi.selected_world_info.splice(0,wi.selected_world_info.length,...next);}
   else throw Error('当前酒馆不支持安全更新全局世界书');
   if(wi.world_info)wi.world_info.globalSelect=[...next];
   context().saveSettingsDebounced?.();
   // Native options use world_names indexes; only refresh the Select2 display.
   if(jquery){const picker=jquery('#world_info');picker.find('option').each(function(){jquery(this).prop('selected',next.includes(wi.world_names?.[Number(this.value)]));});picker.trigger('change.select2');}
  },
  async save(name,data){
   const ctx=context();if(!ctx.getRequestHeaders||!wi.worldInfoCache?.set)throw Error('当前酒馆未提供世界书保存接口，尚未写入');
   const baseline=baselines.get(data),cached=wi.worldInfoCache.get?.(name);
   if(baseline&&cached&&JSON.stringify(cached)!==baseline)throw Error(`世界书同时被其他操作修改：${name}，请刷新后重试`);
   const response=await request('/api/worldinfo/edit',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({name,data})});
   if(!response.ok)throw Error(`世界书保存失败 (${response.status})：${name}，恢复记录已保留`);
   const latest=wi.worldInfoCache.get?.(name);
   if(baseline&&latest&&JSON.stringify(latest)!==baseline)throw Error(`保存期间世界书又被修改：${name}，恢复记录已保留，请检查条目状态`);
   wi.worldInfoCache.set(name,structuredClone(data));
   const ev=ctx.eventTypes??ctx.event_types??{};if(ev.WORLDINFO_UPDATED)await ctx.eventSource?.emit(ev.WORLDINFO_UPDATED,name,structuredClone(data));
  },
 };
}
