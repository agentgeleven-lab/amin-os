import { uuid } from '../../../../uuid.js';
import { managesModule } from '../../../linkage/policy.js';
import { chatIdentity, STORAGE_KEY } from '../adapters/chat.js';
import { mapPath } from '../core/hierarchy.js';
import { connectionDetails, prepareDocument } from '../core/spatial.js';
import { pointCell } from '../core/tiles.js';
import { cellRules, regionName, cellKey } from '../core/cells.js';
import { subscribeStateChanges, acquireMetadataWrite, captureContext, assertContext, chatIdentity as operationIdentity } from '../../../shared/operations.js';
export const BRIDGE_KEY='dynamicMapIntegration';
export const HISTORY_KEY='dynamicMapPositionHistoryV1';
const parse=v=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return null;}};
const visible=n=>n?.discovered&&n.ai?.includeInContext;
export function integrationSummary(document,revision){
 const doc=prepareDocument(document),map=doc.maps[doc.activeMap],current=map.nodes[map.currentLocation],node=visible(current)?current:null;
 const cell=node&&map.type!=='graph'?map.metadata.cells?.[cellKey(pointCell(map.type,node.position))]:null,rules=cellRules(map);
 const path=mapPath(doc,map.id);const safePath=path.filter((m,i)=>i===0||visible(path[i-1].nodes[m.metadata.parentNode]));
 return {来源:'动态地图插件',协议版本:1,地图版本:revision,地图ID:map.id,地图名称:map.name,地点ID:node?.id??null,地点名称:node?.name??null,位置路径:node?[...safePath.map(m=>m.name),node.name].join(' → '):'',区域类型:rules.areas.find(t=>t.id===cell?.area)?.name??'',地形:rules.terrains.find(t=>t.id===cell?.terrain)?.name??'',行政归属:cell?regionName(map,cell.region):'',相邻地点:node?connectionDetails(map,node.id,map.metadata.rules.methods[0].id).filter(l=>l.accessible&&visible(l.node)).map(l=>({地点ID:l.node.id,名称:l.node.name,方位:l.direction.label,距离:l.distance,单位:l.unit,道路类型:map.metadata.roadTypes.find(t=>t.id===l.edge.type)?.name??l.edge.type,单向:!l.edge.bidirectional})):[]};
}
export function createVariableBridge({store,persistence,getContext,loadVariables=()=>import('/scripts/variables.js'),getLwb=()=>globalThis.LWB_StateV2,interval=750}){
 let stopped=false,busy=false,metadata=null,previous=[],lastRequest='',message='等待聊天地图',movement='',writer=null;
 const listeners=new Set();const report=text=>{message=text;for(const fn of listeners)fn(status());};
 const settings=()=>({variables:true,hud:true,allowMoves:false,...getContext()?.extensionSettings?.[BRIDGE_KEY]});
 const bound=()=>{(persistence.ensureReadable??persistence.ensureActive)();const ctx=getContext();if(!chatIdentity(ctx)||!ctx.chatMetadata?.[STORAGE_KEY]?.document)return null;return ctx;};
 const currentSummary=()=>{try{const ctx=bound();return ctx?integrationSummary(store.snapshot(),ctx.chatMetadata[STORAGE_KEY].updatedAt):null;}catch{return null;}};
 function status(){return {message:[message,movement].filter(Boolean).join(' · '),littleWhiteBox:!!getLwb()?.applyText,statusHud:globalThis.WorldStatusHudMapBridge?.version===1,...settings()};}
 function requestMove(request){
  if(managesModule(getContext(),'map'))throw Error('地图已由统一联动管理，旧移动请求不会重复执行');
  if(!settings().allowMoves)throw new Error('未开启 AI 位置更新');const ctx=bound();if(!ctx)throw new Error('请先保存当前聊天地图');
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['请求ID','地图版本','地图ID','地点ID'].includes(k))||typeof request.请求ID!=='string'||!request.请求ID.trim()||request.请求ID.length>160||typeof request.地图ID!=='string'||typeof request.地点ID!=='string')throw new Error('移动请求格式无效');
  if(request.地图版本!==ctx.chatMetadata[STORAGE_KEY].updatedAt)throw new Error('地图版本已变化，请按最新摘要重新请求');
  const doc=store.snapshot(),target=doc.maps[request.地图ID]?.nodes[request.地点ID];if(!visible(target))throw new Error('目标地点不存在、未发现或不允许联动');
  store.applyUpdate([{type:'setActiveMap',mapId:request.地图ID},{type:'setCurrentLocation',mapId:request.地图ID,nodeId:request.地点ID}]);movement='位置更新已应用';return currentSummary();
 }
 async function positionHistory(ctx){
  if(!Array.isArray(ctx.chat))return;
  if(!ctx.chat.length){
   if(previous.length){previous=[];store.applyUpdate([{type:'setCurrentLocation',nodeId:null}]);lastRequest=JSON.stringify(ctx.chatMetadata.variables?.地图移动请求);return;}
   if(ctx.chatMetadata[HISTORY_KEY]?.sequence?.length){const release=acquireMetadataWrite(getContext);try{ctx.chatMetadata[HISTORY_KEY]={...ctx.chatMetadata[HISTORY_KEY],sequence:[]};await ctx.saveMetadata();}finally{release();}}return;
  }
  const history=structuredClone(ctx.chatMetadata[HISTORY_KEY]??{records:{}}),now=[],assigned=[];
  for(const m of ctx.chat){const id=m.extra?.dynamic_map_message_id??uuid();if(!m.extra?.dynamic_map_message_id)assigned.push([m,id]);now.push(id+':'+String(m.swipe_id??0));}
  const rollback=previous.length&&(now.length<previous.length&&now.every((id,i)=>id===previous[i])||now.length===previous.length&&now.at(-1)!==previous.at(-1)&&now.slice(0,-1).every((id,i)=>id===previous[i]));
  if(rollback){const saved=history.records[now.at(-1)]??history.records[now.at(-2)],doc=store.snapshot(),target=saved&&doc.maps[saved.mapId]?.nodes[saved.nodeId];
   if(saved&&target?.discovered)store.applyUpdate([{type:'setActiveMap',mapId:saved.mapId},{type:'setCurrentLocation',mapId:saved.mapId,nodeId:saved.nodeId}]);
   else store.applyUpdate([{type:'setCurrentLocation',nodeId:null}]);
   // Restored variable requests must not replay a past move.
   lastRequest=JSON.stringify(ctx.chatMetadata.variables?.地图移动请求);report(target?'已恢复对应楼层位置':'该楼层无有效位置记录，当前位置已清空');
   previous=now;return;
  }
  const doc=store.snapshot(),value={mapId:doc.activeMap,nodeId:doc.maps[doc.activeMap].currentLocation},key=now.at(-1);
  const changed=JSON.stringify(history.records[key])!==JSON.stringify(value)||JSON.stringify(history.sequence)!==JSON.stringify(now)||assigned.length;
  previous=now;
  if(changed){
   const token=captureContext(getContext),release=acquireMetadataWrite(getContext,token);
   try{for(const [message,id]of assigned){message.extra??={};message.extra.dynamic_map_message_id=id;}history.records[key]=value;history.sequence=now;ctx.chatMetadata[HISTORY_KEY]=history;
    if(assigned.length&&ctx.saveChat)await ctx.saveChat();assertContext(getContext,token);await ctx.saveMetadata();
   }finally{release();}
  }
 }
 async function sync(){
  if(stopped||busy||persistence.suspended?.())return;busy=true;
  try{
   const ctx=bound();if(!ctx){report('尚未保存聊天地图，不发布示例数据');return;}
   if(metadata!==ctx.chatMetadata){metadata=ctx.chatMetadata;previous=metadata[HISTORY_KEY]?.sequence??[];movement='';lastRequest=JSON.stringify(metadata.variables?.地图移动请求);}
   await positionHistory(ctx);if(stopped||persistence.suspended?.()||getContext().chatMetadata!==ctx.chatMetadata)return;
   const cfg=settings(),raw=JSON.stringify(metadata.variables?.地图移动请求);
   if(raw!==lastRequest){lastRequest=raw;if(cfg.allowMoves&&getLwb()?.applyText){try{requestMove(parse(metadata.variables?.地图移动请求));}catch(e){movement='移动未应用：'+e.message;report(message);}}}
   if(persistence.suspended?.())return;
   if(!cfg.variables)return;
   const summary=currentSummary(),existing=parse(metadata.variables?.地图);
   if(metadata.variables?.地图!=null&&metadata.variables.地图!==''&&existing?.来源!=='动态地图插件'){report('聊天变量“地图”已被其他内容占用，未覆盖');return;}
   if(JSON.stringify(existing)===JSON.stringify(summary))return;
   const identity=chatIdentity(ctx),target=metadata,revision=ctx.chatMetadata[STORAGE_KEY].updatedAt;
   writer??=await loadVariables();if(stopped||persistence.suspended?.()||getContext().chatMetadata!==target||chatIdentity(getContext())!==identity||getContext().chatMetadata[STORAGE_KEY]?.updatedAt!==revision||!settings().variables)return;
   persistence.ensureActive();const release=acquireMetadataWrite(getContext);
   try{writer.setLocalVariable('地图',JSON.stringify(summary));
    const actual=parse(getContext().chatMetadata.variables?.地图);if(JSON.stringify(actual)!==JSON.stringify(summary))throw new Error('变量写入被宿主或变量规则拒绝');
    await getContext().saveMetadata();if(getContext().chatMetadata===target)report('地图摘要已同步到聊天变量');
   }finally{release();}
  }catch(e){report('联动未同步：'+e.message);}finally{busy=false;}
 }
 const offExternal=subscribeStateChanges((detail,eventMetadata)=>{
  const ctx=getContext();if(detail.phase!=='applied'||(eventMetadata&&eventMetadata!==ctx.chatMetadata)||detail.identity!==operationIdentity(ctx)||!detail.paths.some(path=>path[0]===STORAGE_KEY))return;
  metadata=ctx.chatMetadata;
  const sequence=(ctx.chat??[]).map(m=>m.extra?.dynamic_map_message_id?m.extra.dynamic_map_message_id+':'+String(m.swipe_id??0):null);
  previous=sequence.some(value=>value===null)?[]:sequence;
  lastRequest=JSON.stringify(metadata.variables?.地图移动请求);movement='已同步联合操作的位置';
 });
 const off=store.subscribe(()=>{void sync();}),offSettled=persistence.subscribeSettled?.(()=>{void sync();});const timer=interval?setInterval(()=>void sync(),interval):null;void sync();
 return {sync,status,summary:currentSummary,requestMove,configure(patch){const ctx=getContext();ctx.extensionSettings??={};const next={...settings(),...patch};for(const k of ['variables','hud','allowMoves'])if(typeof next[k]!=='boolean')throw new Error('无效联动设置');ctx.extensionSettings[BRIDGE_KEY]=next;ctx.saveSettingsDebounced?.();report('联动设置已保存');void sync();},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},destroy(){stopped=true;off();offExternal();offSettled?.();if(timer)clearInterval(timer);listeners.clear();}};
}
