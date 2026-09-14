const listeners=new Map();
const events=Object.fromEntries(['GENERATION_AFTER_COMMANDS','GENERATION_STOPPED','APP_INITIALIZED','CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_UPDATED','GENERATION_ENDED','CHARACTER_MESSAGE_RENDERED'].map(x=>[x,x]));
const state=name=>JSON.stringify({版本:1,项目:{玩家:{姓名:name,生命:{当前:76,最大:100},金币:128,背包:['地图','恢复药剂']},世界:{地点:'星港 · 观测站',时间:'黄昏',天气:'微雨'}}});
const contexts=['a','b'].map((id,i)=>({id,variables:{状态栏:state(i?'另一位旅人':'旅人')}}));let active=0;
const settings={dynamicMapNamespace:'amin-preview-only',world_status_hud_v1:{floorButtons:false}};
const ctx={characterId:0,characters:[{avatar:'amin-preview.png',name:'向导',data:{description:'星港的向导',extensions:{}}}],chatMetadata:contexts[0],chat:[{name:'旅人',is_user:true,mes:'我来到观测站。',extra:{}},{name:'向导',is_user:false,mes:'我们一起出发吧。',extra:{}}],name1:'旅人',name2:'向导',extensionSettings:settings,worldInfoSettings:{world_info:{globalSelect:['演示技能']}},powerUserSettings:{persona_description:'探索未知的旅人'},eventTypes:events,event_types:events,getCurrentChatId:()=>contexts[active].id,
eventSource:{on(e,f){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(f);},removeListener(e,f){listeners.get(e)?.delete(f);},async emit(e,...args){for(const f of listeners.get(e)??[])await f(...args);}},
async saveMetadata(){},saveMetadataDebounced(){},saveSettingsDebounced(){},async saveChat(){},setExtensionPrompt(key,text){if(!['amin-os-persistent-effects','amin-os-information-panel'].includes(key))return;document.getElementById('preview-effects-prompt')?.replaceChildren(document.createTextNode(text));},async loadWorldInfo(){return {entries:{0:{uid:0,comment:'所有权（演示）',content:'所有权：持有者可声明目标特定层面的所有权。关系持续至主动解除或转让；当前指令变化不自动解除关系。死亡与继承按规则确认。'}}};},
async generateRaw(request){await new Promise(r=>setTimeout(r,350));
  if(request.systemPrompt?.includes('信息面板资料检索助手'))return JSON.stringify({queries:['向导','观测站']});
  if(request.systemPrompt?.includes('信息面板资料整理助手'))return JSON.stringify({fields:[{category:'身份',label:'身份说明',value:'星港的向导',status:'known',sources:[{id:'card:amin-preview.png:0',quote:'星港的向导'}]},{category:'能力',label:'星语资质',value:'能理解星辰低语',status:'invented',sources:[]},{category:'档案',label:'年龄',value:'未查到',status:'unknown',sources:[]}]});
  if(request.systemPrompt?.includes('信息面板模拟推演助手'))return JSON.stringify({summary:'模拟：新增职业可能需要配套经历。尚未应用。',proposals:[{category:'经历',label:'学习记录',value:'曾在星港学习星象学',reason:'为新增能力提供履历基础'}]});
  if(request.systemPrompt?.includes('持续效果规则编辑助手'))return '适用范围：仅对已确认目标和指定层面生效。\n持续：直到主动解除或转让。\n指令变更不解除所有权关系。\n死亡及继承：依原规则人工确认。';
  if(request.systemPrompt?.includes('回复拟稿助手'))return JSON.stringify(['“那就出发吧。”我跟上她，沿着旧路向山脊走去。','“你来过这里多少次？”我望向观测站，放慢了脚步。','我把地图展开，仔细核对通往山顶的另一条路线。']);
  if(request.systemPrompt?.includes('状态')||request.prompt?.includes('状态栏'))return state('旅人');
  const {createDemoDocument}=await import('./apps/map/src/core/demo.js');return JSON.stringify(createDemoDocument());
}};
globalThis.SillyTavern={getContext:()=>ctx};
document.getElementById('preview-switch').onclick=()=>{active=1-active;ctx.chatMetadata=contexts[active];ctx.chat=ctx.chat.map(m=>({...m,extra:{}}));ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-group').onclick=()=>{ctx.groupId=ctx.groupId?undefined:'preview-group';ctx.groups=[{id:'preview-group',members:['amin-preview.png']}];ctx.eventSource.emit(events.CHAT_CHANGED);};
document.getElementById('preview-empty').onclick=()=>{delete ctx.chatMetadata.variables.状态栏;ctx.eventSource.emit(events.CHAT_CHANGED);};
const testButton=document.createElement('button');testButton.textContent='预览本轮持续提醒';testButton.onclick=()=>ctx.eventSource.emit(events.GENERATION_AFTER_COMMANDS,'normal',{},false);const prompt=document.createElement('pre');prompt.id='preview-effects-prompt';document.body.append(testButton,prompt);
await import('./index.js');
