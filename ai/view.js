import {fetchModels} from './models.js';
import {getAI} from './service.js';
import {renderPresetEditor} from '../apps/map/src/ui/generation-presets.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const input=(value='',type='text')=>{const e=el('input');e.type=type;e.value=value;return e;};
const field=(parent,label,control)=>{const wrap=el('label');wrap.append(el('span',label),control);parent.append(wrap);return control;};
const select=(items,value)=>{const e=el('select');for(const p of items){const o=el('option',p.name);o.value=p.id;e.append(o);}e.value=value;return e;};
const button=(text,fn)=>{const e=el('button',text);e.type='button';if(['保存并应用到全部应用','保存预设'].includes(text))e.classList.add('amin-primary');e.onclick=fn;return e;};
export function mount(target){
 const ai=getAI();target.classList.add('amin-ai');let active='api',modelController,selectedProfile=ai.profiles.binding('shared')||'';
 function draw(){
  modelController?.abort();
  target.replaceChildren();target.append(el('h2','AI 设置'),el('p','统一应用于全部应用。保存后，下一次生成使用新设置；正在等待的任务保留原配置。'));
  const tabs=el('nav');tabs.setAttribute('aria-label','AI 设置分类');target.append(tabs);
  const api=el('section'),config=ai.settings.snapshot();target.append(api);
  const saved=ai.profiles.list();
  if(!saved.some(p=>p.id===selectedProfile))selectedProfile='';
  const pick=field(api,'已保存的 API 设置',select([{id:'',name:'当前设置 / 未选择配置'},...saved],selectedProfile));
  const name=field(api,'配置名称',input(saved.find(p=>p.id===selectedProfile)?.name||'我的 API'));
  const mode=field(api,'模型连接',select([{id:'host',name:'读取酒馆配置后直连'},{id:'custom',name:'手动配置直连接口'}],config.enabled?'custom':'host'));
  const address=field(api,'API 地址',input(config.baseUrl)),model=field(api,'模型名称',input(config.model)),key=field(api,'API 密钥',input(config.apiKey,'password'));key.autocomplete='off';
  const remember=field(api,'记住密钥（仅本浏览器）',input('','checkbox'));remember.checked=config.rememberKey;
  const updateMode=()=>{address.disabled=model.disabled=key.disabled=remember.disabled=mode.value==='host';};mode.onchange=updateMode;updateMode();
  const tokens=field(api,'最大输出 tokens',input(config.maxTokens,'number')),timeout=field(api,'等待上限（秒，含排队）',input(config.timeoutSeconds,'number'));
  const queue=field(api,'所有应用的任务策略',select([{id:'serial',name:'依次排队'},{id:'parallel',name:'允许并行'}],config.queueMode));
  const stream=field(api,'独立 API 流式接收（完整后应用）',input('','checkbox'));stream.checked=config.stream;
  const notice=el('p');notice.setAttribute('role','status');
  const safe=fn=>{try{fn();notice.textContent='已保存，对全部应用生效。';}catch(e){notice.textContent=e.message;}};
  const read=()=>({enabled:mode.value==='custom',baseUrl:address.value,model:model.value,apiKey:key.value,rememberKey:remember.checked,maxTokens:Number(tokens.value),timeoutSeconds:Number(timeout.value),queueMode:queue.value,stream:stream.checked});
  const modelList=field(api,'可用模型',select([{id:'',name:'请先拉取模型列表'}],''));modelList.disabled=true;
  let resolvedConnection;
  const invalidateModels=()=>{modelController?.abort();resolvedConnection=undefined;modelList.replaceChildren();modelList.disabled=true;};
  for(const control of [address,key])control.addEventListener('input',invalidateModels);
  mode.addEventListener('change',invalidateModels);
  const fetchButton=button('拉取模型列表',async()=>{
   invalidateModels();const controller=new AbortController();modelController=controller;fetchButton.disabled=true;notice.textContent='正在拉取模型列表…';
   try{const result=await fetchModels(read(),{signal:controller.signal});if(controller!==modelController||controller.signal.aborted)return;resolvedConnection=result.connection;modelList.replaceChildren();const placeholder=el('option','请选择模型');placeholder.value='';modelList.append(placeholder);for(const id of result.models){const option=el('option',id);option.value=id;modelList.append(option);}modelList.value=result.models.includes(model.value)?model.value:'';modelList.disabled=false;notice.textContent=`已读取 ${result.models.length} 个模型。选择后保存生效；也可以手动填写。`;}
   catch(e){if(controller===modelController)notice.textContent=e.message;}
   finally{if(controller===modelController)fetchButton.disabled=false;}
  });
  modelList.onchange=()=>{if(!modelList.value)return;if(mode.value==='host'&&resolvedConnection){mode.value='custom';address.value=resolvedConnection.baseUrl;key.value=resolvedConnection.apiKey;remember.checked=false;updateMode();notice.textContent='已复制酒馆连接供此配置使用，密钥默认仅本次会话保存。请保存配置。';}model.value=modelList.value;};
  api.append(fetchButton);
  api.append(button('保存并应用到全部应用',()=>safe(()=>ai.settings.save(read()))),button('清除共享密钥',()=>safe(()=>{key.value='';remember.checked=false;ai.settings.save({...ai.settings.snapshot(),apiKey:'',rememberKey:false});})),notice);
  api.append(el('p','独立接口需允许浏览器跨域请求。密钥默认只保留在当前页面会话中。读取酒馆配置支持 OpenAI、自定义兼容接口与 OpenRouter；只读取地址、模型及允许读取的密钥，生成由 Amin os 独立请求。密钥不可读取时，请选择手动配置并填写。'));
  pick.onchange=()=>{try{if(!pick.value){selectedProfile='';ai.profiles.bind('shared','');draw();return;}const value=ai.profiles.get(pick.value);if(!value)throw Error('配置不存在');ai.settings.save(value);selectedProfile=pick.value;ai.profiles.bind('shared',selectedProfile);draw();}catch(e){notice.textContent=e.message;}};
  const saveProfile=copy=>{const label=name.value.trim();if(!label)throw Error('请输入配置名称');const value=read(),id=copy||!selectedProfile?crypto.randomUUID():selectedProfile;ai.profiles.save(id,label,value);ai.settings.save(value);ai.profiles.bind('shared',id);selectedProfile=id;draw();};
  api.append(button('保存为新配置',()=>safe(()=>saveProfile(true))),button('更新所选配置',()=>safe(()=>{if(!selectedProfile)throw Error('请先选择要更新的配置');saveProfile(false);})),button('删除所选配置',()=>safe(()=>{if(!selectedProfile)throw Error('请先选择配置');ai.profiles.remove(selectedProfile);selectedProfile='';draw();})));
  api.append(button('导入原地图 / 状态栏配置',()=>safe(()=>{ai.importLegacy();draw();})),el('p','导入后请在上方选择并应用配置；原设置保留。原状态栏会话密钥需重新填写。'));
  const preset=el('section');target.append(preset);
  const help='全局异步生成预设：按顺序组合消息，可编辑、启停和排序。三个应用均提供角色卡、世界书与可用聊天资料；地图额外提供当前地图。“本次要求”必须启用。各应用的输出协议始终附加。';
  const library={...ai.presets,save(p){if(!p.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('请保留并启用“本次要求”块');ai.presets.save(p);}};
  renderPresetEditor(preset,library,ai.selected(),id=>ai.select(id),{el,input,field,select,button,uid:()=>crypto.randomUUID(),help});
  const runtime=el('section');target.append(runtime);
  const refresh=()=>{runtime.replaceChildren(el('h3','任务与实际提示词'));for(const t of ai.tasks()){const row=el('p',`${t.app} · ${t.state}`);if(t.state==='等待模型 / 排队中')row.append(button('取消',()=>ai.cancel(t.id)));runtime.append(row);}for(const p of ai.previews()){const d=el('details');d.append(el('summary',`${p.app} · 最近一次请求`),el('pre',p.text));runtime.append(d);}runtime.append(el('p','提示词只在当前页面显示。取消任务会中止插件请求并丢弃结果；不调用酒馆生成流程。'));};
  const panels={api,preset,runtime};const labels={api:'API 连接',preset:'异步预设',runtime:'任务记录'};
  const show=()=>{for(const [id,panel]of Object.entries(panels))panel.hidden=id!==active;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b.dataset.page===active));};
  for(const id of Object.keys(panels)){const b=button(labels[id],()=>{active=id;show();});b.dataset.page=id;tabs.append(b);}
  show();refresh();unsubscribe?.();unsubscribe=ai.subscribe(refresh);
 }
 let unsubscribe;draw();return {open(){draw();}};
}
