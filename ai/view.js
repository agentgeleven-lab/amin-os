import {parseRequestBody} from '../apps/map/src/adapters/request-body.js';
import {fetchModels} from './models.js';
import {getAI,AI_APPS} from './service.js';
import {renderPresetEditor} from '../apps/map/src/ui/generation-presets.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const input=(value='',type='text')=>{const e=el('input');e.type=type;e.value=value;return e;};
const field=(parent,label,control)=>{const wrap=el('label');wrap.append(el('span',label),control);parent.append(wrap);return control;};
const select=(items,value)=>{const e=el('select');for(const p of items){const o=el('option',p.name);o.value=p.id;e.append(o);}e.value=value;return e;};
const button=(text,fn)=>{const e=el('button',text);e.type='button';if(['保存全局默认设置','保存预设'].includes(text))e.classList.add('amin-primary');e.onclick=fn;return e;};
export function mount(target){
 const ai=getAI();target.classList.add('amin-ai');let active='api',modelController,selectedProfile=ai.profiles.binding('shared')||'';
 function draw(){
  modelController?.abort();
  target.replaceChildren();target.append(el('h2','AI 设置'),el('p','应用默认使用全局渠道，也可在“应用渠道”中指定已保存的 API 配置。修改后下一次生成生效；进行中的任务保留原配置。'));
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
  const queue=field(api,'此渠道的任务策略',select([{id:'serial',name:'依次排队'},{id:'parallel',name:'允许并行'}],config.queueMode));
  const stream=field(api,'独立 API 流式接收（完整后应用）',input('','checkbox'));stream.checked=config.stream;
  const advanced=el('details');advanced.append(el('summary','OpenAI Compatible · 自定义请求参数'));const requestBody=el('textarea');requestBody.rows=10;requestBody.spellcheck=false;requestBody.style.fontFamily='monospace';requestBody.style.width='100%';requestBody.value=config.requestBody||'';requestBody.placeholder='{\n  "temperature": 0.8,\n  "top_p": 0.95\n}';field(advanced,'requestBody（JSON 对象）',requestBody);advanced.append(el('p','留空使用默认请求体。按顶层字段覆盖，嵌套对象整体替换；null 删除字段。例如用 max_tokens: null 配合 max_completion_tokens。model、messages 和 stream 也可覆盖；覆盖 messages 会替换应用提示词，可能影响输出格式；覆盖后可在「任务记录」的最近一次请求中查看实际发送的内容。不要在这里填写 API 密钥或请求头；此处随配置明文保存。'));api.append(advanced);
  const notice=el('p');notice.setAttribute('role','status');
  const safe=fn=>{try{fn();notice.textContent='已保存；使用此配置的应用将在下次生成时生效。';}catch(e){notice.textContent=e.message;}};
  advanced.append(button('检查并格式化 JSON',()=>{try{requestBody.value=JSON.stringify(parseRequestBody(requestBody.value),null,2);notice.textContent='JSON 格式正确，请保存后应用。';}catch(e){notice.textContent=e.message;}}));
  const read=()=>({requestBody:requestBody.value,enabled:mode.value==='custom',baseUrl:address.value,model:model.value,apiKey:key.value,rememberKey:remember.checked,maxTokens:Number(tokens.value),timeoutSeconds:Number(timeout.value),queueMode:queue.value,stream:stream.checked});
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
  api.append(button('保存全局默认设置',()=>safe(()=>ai.settings.save(read()))),button('清除共享密钥',()=>safe(()=>{key.value='';remember.checked=false;ai.settings.save({...ai.settings.snapshot(),apiKey:'',rememberKey:false});})),notice);
  api.append(el('p','独立接口需允许浏览器跨域请求。密钥默认只保留在当前页面会话中。读取酒馆配置支持 OpenAI、自定义兼容接口与 OpenRouter；只读取地址、模型及允许读取的密钥，生成由 Amin os 独立请求。密钥不可读取时，请选择手动配置并填写。'));
  pick.onchange=()=>{try{if(!pick.value){selectedProfile='';ai.profiles.bind('shared','');draw();return;}const value=ai.profiles.get(pick.value);if(!value)throw Error('配置不存在');ai.settings.save(value);selectedProfile=pick.value;ai.profiles.bind('shared',selectedProfile);draw();}catch(e){notice.textContent=e.message;}};
  const saveProfile=copy=>{const label=name.value.trim();if(!label)throw Error('请输入配置名称');const value=read(),id=copy||!selectedProfile?crypto.randomUUID():selectedProfile;ai.profiles.save(id,label,value);ai.settings.save(value);ai.profiles.bind('shared',id);selectedProfile=id;draw();};
  api.append(button('保存为新配置',()=>safe(()=>saveProfile(true))),button('更新所选配置',()=>safe(()=>{if(!selectedProfile)throw Error('请先选择要更新的配置');saveProfile(false);})),button('删除所选配置',()=>safe(()=>{if(!selectedProfile)throw Error('请先选择配置');ai.profiles.remove(selectedProfile);selectedProfile='';draw();})));
  api.append(button('导入原地图 / 状态栏配置',()=>safe(()=>{ai.importLegacy();draw();})),el('p','导入后请在上方选择并应用配置；原设置保留。原状态栏会话密钥需重新填写。'));
  const channels=el('section');target.append(channels);
  channels.append(el('h3','应用 API 渠道'),el('p','先在“API 连接”保存配置，再为各应用选择渠道。渠道包含地址、密钥、模型、请求参数与生成限额；异步预设仍共用。'));
  const channelNotice=el('p');channelNotice.setAttribute('role','status');
  for(const app of AI_APPS){
   const control=field(channels,app.name,select([{id:'',name:'跟随全局默认'},...saved],ai.channel(app.id)));
   control.onchange=()=>{try{ai.setChannel(app.id,control.value);channelNotice.textContent=app.name+'渠道已保存，下次生成生效。';}catch(e){channelNotice.textContent=e.message;control.value=ai.channel(app.id);}};
  }
  channels.append(channelNotice,el('p','同一渠道可供多个应用使用。更新已保存的配置会影响绑定它的应用；删除配置后，相关应用恢复跟随全局默认。密钥未选择记住时，重新打开页面后需重新填写。'));
  channels.append(el('p','语音朗读使用专用语音接口，在语音应用内选择 MiMo、火山引擎或本地服务并配置密钥。'),button('打开语音设置',()=>globalThis.AminOS?.openApp('tts')));
  const preset=el('section');target.append(preset);
  const help='全局异步生成预设：按顺序组合消息，可编辑、启停和排序。各应用按需提供角色卡、世界书与可用聊天资料；地图额外提供当前地图。“本次要求”必须启用。各应用的输出协议始终附加。';
  const library={...ai.presets,save(p){if(!p.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('请保留并启用“本次要求”块');ai.presets.save(p);}};
  renderPresetEditor(preset,library,ai.selected(),id=>ai.select(id),{el,input,field,select,button,uid:()=>crypto.randomUUID(),help});
  const runtime=el('section');target.append(runtime);
  const refresh=()=>{runtime.replaceChildren(el('h3','任务与实际提示词'));for(const t of ai.tasks()){const row=el('p',`${t.app} · ${t.channel} · ${t.state}`);if(t.state==='等待模型 / 排队中')row.append(button('取消',()=>ai.cancel(t.id)));runtime.append(row);}for(const p of ai.previews()){const d=el('details');d.append(el('summary',`${p.app} · 最近一次请求`),el('pre',p.text));runtime.append(d);}runtime.append(el('p','这里显示实际发送的请求内容，包含自定义请求参数的覆盖结果。提示词只在当前页面显示。取消任务会中止插件请求并丢弃结果；不调用酒馆生成流程。'));};
  const panels={api,channels,preset,runtime};const labels={api:'API 连接',channels:'应用渠道',preset:'异步预设',runtime:'任务记录'};
  const show=()=>{for(const [id,panel]of Object.entries(panels))panel.hidden=id!==active;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b.dataset.page===active));};
  for(const id of Object.keys(panels)){const b=button(labels[id],()=>{active=id;show();});b.dataset.page=id;tabs.append(b);}
  show();refresh();unsubscribe?.();unsubscribe=ai.subscribe(refresh);
 }
 let unsubscribe;draw();return {open(){draw();}};
}
