const listeners=new Map();
const events=Object.fromEntries(['APP_INITIALIZED','CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_UPDATED','GENERATION_ENDED','CHARACTER_MESSAGE_RENDERED'].map(x=>[x,x]));
const state=name=>JSON.stringify({版本:1,项目:{玩家:{姓名:name,生命:{当前:76,最大:100},金币:128,背包:['地图','恢复药剂']},世界:{地点:'星港 · 观测站',时间:'黄昏',天气:'微雨'}}});
const contexts=['a','b'].map((id,i)=>({id,variables:{状态栏:state(i?'另一位旅人':'旅人')}}));let active=0;
const settings={dynamicMapNamespace:'amin-preview-only',world_status_hud_v1:{floorButtons:false}};
const ctx={characterId:0,characters:[{avatar:'amin-preview.png',name:'向导',data:{description:'星港的向导',extensions:{}}}],chatMetadata:contexts[0],chat:[{name:'旅人',is_user:true,mes:'我来到观测站。',extra:{}},{name:'向导',is_user:false,mes:'我们一起出发吧。',extra:{}}],name1:'旅人',name2:'向导',extensionSettings:settings,worldInfoSettings:{},powerUserSettings:{persona_description:'探索未知的旅人'},eventTypes:events,event_types:events,getCurrentChatId:()=>contexts[active].id,
eventSource:{on(e,f){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(f);},removeListener(e,f){listeners.get(e)?.delete(f);},async emit(e,...args){for(const f of listeners.get(e)??[])await f(...args);}},
async saveMetadata(){},saveMetadataDebounced(){},saveSettingsDebounced(){},async saveChat(){},async loadWorldInfo(){return {entries:{}};},
async generateRaw(request){await new Promise(r=>setTimeout(r,350));
  if(request.systemPrompt?.includes('回复拟稿助手'))return JSON.stringify(['“那就出发吧。”我跟上她，沿着旧路向山脊走去。','“你来过这里多少次？”我望向观测站，放慢了脚步。','我把地图展开，仔细核对通往山顶的另一条路线。']);
  if(request.systemPrompt?.includes('状态')||request.prompt?.includes('状态栏'))return state('旅人');
  const {createDemoDocument}=await import('./apps/map/src/core/demo.js');return JSON.stringify(createDemoDocument());
}};
globalThis.SillyTavern={getContext:()=>ctx};
document.getElementById('preview-switch').onclick=()=>{active=1-active;ctx.chatMetadata=contexts[active];ctx.chat=ctx.chat.map(m=>({...m,extra:{}}));ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-group').onclick=()=>{ctx.groupId=ctx.groupId?undefined:'preview-group';ctx.groups=[{id:'preview-group',members:['amin-preview.png']}];ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-empty').onclick=()=>{delete ctx.chatMetadata.variables.状态栏;ctx.eventSource.emit(events.CHAT_CHANGED);};
await import('./index.js');
