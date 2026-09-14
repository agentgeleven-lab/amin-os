import {getAI} from './service.js';
import {renderPresetEditor} from '../apps/map/src/ui/generation-presets.js';
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const input=(value='',type='text')=>{const e=el('input');e.type=type;e.value=value;return e;};
const field=(parent,label,control)=>{const wrap=el('label');wrap.append(el('span',label),control);parent.append(wrap);return control;};
const select=(items,value)=>{const e=el('select');for(const p of items){const o=el('option',p.name);o.value=p.id;e.append(o);}e.value=value;return e;};
const button=(text,fn)=>{const e=el('button',text);e.type='button';e.onclick=fn;return e;};
export function mount(target){
 const ai=getAI();target.classList.add('amin-ai');let active='api';
 function draw(){
  target.replaceChildren();target.append(el('h2','AI 设置'),el('p','统一应用于地图、世界状态和回复选项。保存后，下一次生成使用新设置；正在等待的任务保留原配置。'));
  const tabs=el('nav');tabs.setAttribute('aria-label','AI 设置分类');target.append(tabs);
  const api=el('section'),config=ai.settings.snapshot();target.append(api);
  const mode=field(api,'模型连接',select([{id:'host',name:'酒馆当前连接'},{id:'custom',name:'独立 API（Chat Completions）'}],config.enabled?'custom':'host'));
  const address=field(api,'API 地址',input(config.baseUrl)),model=field(api,'模型名称',input(config.model)),key=field(api,'API 密钥',input(config.apiKey,'password'));key.autocomplete='off';
  const remember=field(api,'记住密钥（仅本浏览器）',input('','checkbox'));remember.checked=config.rememberKey;
  const tokens=field(api,'最大输出 tokens',input(config.maxTokens,'number')),timeout=field(api,'等待上限（秒，含排队）',input(config.timeoutSeconds,'number'));
  const queue=field(api,'所有应用的任务策略',select([{id:'serial',name:'依次排队'},{id:'parallel',name:'允许并行'}],config.queueMode));
  const stream=field(api,'独立 API 流式接收（完整后应用）',input('','checkbox'));stream.checked=config.stream;
  const notice=el('p');notice.setAttribute('role','status');
  const safe=fn=>{try{fn();notice.textContent='已保存，对三个应用生效。';}catch(e){notice.textContent=e.message;}};
  const read=()=>({enabled:mode.value==='custom',baseUrl:address.value,model:model.value,apiKey:key.value,rememberKey:remember.checked,maxTokens:Number(tokens.value),timeoutSeconds:Number(timeout.value),queueMode:queue.value,stream:stream.checked});
  api.append(button('保存并应用到全部应用',()=>safe(()=>ai.settings.save(read()))),button('清除共享密钥',()=>safe(()=>{key.value='';remember.checked=false;ai.settings.save({...ai.settings.snapshot(),apiKey:'',rememberKey:false});})),notice);
  api.append(el('p','独立接口需允许浏览器跨域请求。密钥默认只保留在当前页面会话中。酒馆连接使用酒馆自身的连接设置。'));
  const name=field(api,'API 配置名称',input('我的 API'));
  api.append(button('另存 API 配置',()=>safe(()=>{if(!name.value.trim())throw Error('请输入配置名称');ai.profiles.save(crypto.randomUUID(),name.value.trim(),read());draw();})));
  const saved=ai.profiles.list();if(saved.length){const pick=field(api,'已保存 API 配置',select(saved,saved[0].id));api.append(button('应用此 API 配置',()=>safe(()=>{ai.settings.save(ai.profiles.get(pick.value));draw();})),button('删除此 API 配置',()=>{ai.profiles.remove(pick.value);draw();}));}
  api.append(button('导入原地图 / 状态栏配置',()=>safe(()=>{ai.importLegacy();draw();})),el('p','导入后请在上方选择并应用配置；原设置保留。原状态栏会话密钥需重新填写。'));
  const preset=el('section');target.append(preset);
  const help='全局异步生成预设：按顺序组合消息，可编辑、启停和排序。三个应用均提供角色卡、世界书与可用聊天资料；地图额外提供当前地图。“本次要求”必须启用。各应用的输出协议始终附加。';
  const library={...ai.presets,save(p){if(!p.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('请保留并启用“本次要求”块');ai.presets.save(p);}};
  renderPresetEditor(preset,library,ai.selected(),id=>ai.select(id),{el,input,field,select,button,uid:()=>crypto.randomUUID(),help});
  const runtime=el('section');target.append(runtime);
  const refresh=()=>{runtime.replaceChildren(el('h3','任务与实际提示词'));for(const t of ai.tasks()){const row=el('p',`${t.app} · ${t.state}`);if(t.state==='等待模型 / 排队中')row.append(button('取消',()=>ai.cancel(t.id)));runtime.append(row);}for(const p of ai.previews()){const d=el('details');d.append(el('summary',`${p.app} · 最近一次请求`),el('pre',p.text));runtime.append(d);}runtime.append(el('p','提示词只在当前页面显示。取消酒馆连接任务会停止等待并丢弃结果；酒馆底层请求可能继续运行，串行队列会等待它结束。'));};
  const panels={api,preset,runtime};const labels={api:'API 连接',preset:'异步预设',runtime:'任务记录'};
  const show=()=>{for(const [id,panel]of Object.entries(panels))panel.hidden=id!==active;for(const b of tabs.children)b.setAttribute('aria-pressed',String(b.dataset.page===active));};
  for(const id of Object.keys(panels)){const b=button(labels[id],()=>{active=id;show();});b.dataset.page=id;tabs.append(b);}
  show();refresh();unsubscribe?.();unsubscribe=ai.subscribe(refresh);
 }
 let unsubscribe;draw();return {open(){draw();}};
}
