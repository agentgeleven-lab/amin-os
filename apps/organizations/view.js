import {getAI} from '../../ai/service.js';
import {getStore,chatIdentity} from './service.js';
import {GROUPS,LABELS,FIELDS,LINKS,entity,uid,clone,diff,deleteEntity,rankMetrics} from './model.js';
import {generate,followPrompt} from './ai.js';
import {syncWorldbook} from './lorebook.js';
const el=(tag,text='',cls='')=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
const show=v=>v===null||v===undefined||v===''?'未明确':typeof v==='object'?JSON.stringify(v,null,2):String(v);
const tabsMap={overview:'总览',organizations:'组织',alliances:'联盟／阵营',regions:'地区',assessment:'评估排行',settings:'生成与规则'};
const mounted=new WeakMap();
export async function mount(target,{api:provided,ai=getAI}={}){
 mounted.get(target)?.dispose();const api=provided??await getStore();mounted.get(target)?.dispose();
 const page=el('div','','amin-page amin-organizations'),header=el('div','','amin-toolbar'),tabs=el('div','','amin-tabs'),notice=el('div','','amin-notice'),body=el('section');
 notice.setAttribute('role','status');tabs.setAttribute('role','tablist');page.append(header,tabs,notice,body);target.append(page);
 let selected='overview',chosen={},search='',editing=false,disposed=false,historyIndex=null,lastIdentity='',requesting=false;
 const say=t=>{notice.textContent=t;};
 const btn=(parent,label,fn,primary=false)=>{const b=el('button',label,primary?'amin-primary':'');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){say(e.message);}finally{if(!disposed)b.disabled=false;}};parent.append(b);return b;};
 const card=(title,parent=body)=>{const c=el('section','','amin-card');if(title)c.append(el('h3',title));parent.append(c);return c;};
 const field=(parent,label,value='',multi=false)=>{const row=el('label',label),input=el(multi?'textarea':'input');input.value=String(value??'');input.setAttribute('aria-label',label);if(multi)input.rows=3;row.append(input);parent.append(row);return input;};
 const check=(parent,label,value=false)=>{const row=el('label',label),i=el('input');i.type='checkbox';i.checked=!!value;row.append(i);parent.append(row);return i;};
 const select=(parent,label,options,value)=>{const row=el('label',label),i=el('select');i.setAttribute('aria-label',label);for(const[v,n]of options){const o=el('option',n);o.value=v;i.append(o);}i.value=value??options[0]?.[0]??'';row.append(i);parent.append(row);return i;};
 const leave=()=>!editing||globalThis.confirm?.('离开将放弃尚未保存的表单草稿，是否继续？');
 const navigate=(tab,id)=>{if(!leave())return;editing=false;if(tab==='settings')historyIndex=null;selected=tab;if(id)chosen[tab]=id;render();};
 function draftStart(title){editing=true;body.replaceChildren();return card(title);}
 function cancelEdit(){editing=false;render();}
 async function run(mode,targetEntity=null){
  if(requesting||api.busy())throw Error('已有操作进行中');
  if(!leave())return;editing=false;historyIndex=null;requesting=true;say('正在准备资料并请求AI…');
  try{await generate({api,ai:ai(),mode,target:targetEntity});render();say('结果已生成，请检查变更后确认；尚未写入');}
  finally{requesting=false;}
 }
 function drawHeader(){
  header.replaceChildren();header.append(el('strong','势力概览'));
  if(historyIndex!==null){header.append(el('span','正在只读浏览历史'));btn(header,'返回当前资料',()=>{historyIndex=null;render();});return;}
  btn(header,'生成／补充',()=>run('fill'));btn(header,'按当前剧情更新',()=>run('update'));
  btn(header,'重新生成整套',()=>run('replace'));btn(header,'取消请求',()=>{api.cancel();say('已取消请求');});
  btn(header,'重试保存',async()=>{await api.retrySave();say('聊天保存已完成');});
 }
 function drawPreview(p){
  const c=card(p.kind==='assessment'?'评估预览 · 仅供user':'资料变更预览');
  c.append(el('p','确认前不会写入。若当前聊天、楼层、资料或锁定设置发生变化，本结果不能再应用。'));
  if(p.kind==='assessment')drawAssessment(p.assessment,c);
  else{c.append(el('p','变更 '+p.changes.length+' 项'));for(const change of p.changes){const item=el('details');item.append(el('summary',change.label),el('pre','原：'+show(change.before)+'\n新：'+show(change.after)));c.append(item);}}
  const tools=el('div','','amin-toolbar');c.append(tools);
  btn(tools,'确认应用',async()=>{await api.confirm();editing=false;render();say('已写入并保存到当前聊天');},true);
  btn(tools,'放弃结果',()=>{api.discard();editing=false;render();});
 }
 function drawOverview(doc){
  const c=card(doc.name||'尚未建立资料');c.append(el('p',doc.summary||'可从生成／补充开始，也可手动新增组织、联盟和地区。'),el('p','资料时间：'+(doc.time||'未明确')));
  if(historyIndex===null)btn(c,'编辑总览',()=>{
   const token=api.capture(),f=draftStart('编辑总览'),name=field(f,'资料标题',doc.name),summary=field(f,'当前局势',doc.summary,true),time=field(f,'资料时间',doc.time);
   btn(f,'预览保存',()=>{const next=clone(doc);next.name=name.value;next.summary=summary.value;next.time=time.value;api.stage(next,token,{manual:true});editing=false;render();},true);btn(f,'取消',cancelEdit);
  });
  const grid=el('div','','amin-org-grid');body.append(grid);
  for(const group of GROUPS){const c=card(LABELS[group]+' · '+Object.keys(doc[group]).length,grid);for(const[id,e]of Object.entries(doc[group])){const row=el('div','','amin-org-row');btn(row,e.name,()=>{selected=group;chosen[group]=id;render();});row.append(el('span',e.status||e.summary||'未明确'));c.append(row);}}
  const h=card('楼层记录 · 只读');h.append(el('p','仅记录启用后的资料。回退或切换候选会恢复相应状态；未记录的过去不补造数据。'));
  const records=api.history().filter(r=>r.available).slice(-40);
  for(const r of records)btn(h,'第'+(r.index+1)+'楼 · '+r.name,()=>{if(!leave())return;editing=false;historyIndex=r.index;selected='overview';render();});
 }
 function drawGroup(doc,group){
  const toolbar=el('div','','amin-toolbar');body.append(toolbar);
  const query=field(toolbar,'搜索',search);query.onchange=()=>{search=query.value;render();};
  if(historyIndex===null)btn(toolbar,'新增'+LABELS[group],()=>editEntity(group,null));
  const list=Object.entries(doc[group]).filter(([,e])=>!search||[e.name,e.type,e.summary].join(' ').includes(search));
  if(!list.length){body.append(el('p','没有匹配的资料。'));return;}
  if(!list.some(([id])=>id===chosen[group]))chosen[group]=list[0][0];
  const picker=select(toolbar,'选择资料',list.map(([id,e])=>[id,e.name]),chosen[group]);picker.onchange=()=>{chosen[group]=picker.value;render();};
  const id=chosen[group],e=doc[group][id],c=card(e.name);c.append(el('p',(e.type||'类型未明确')+' · '+(e.summary||'概况未明确')));
  if(historyIndex===null){const tools=el('div','','amin-toolbar');c.append(tools);btn(tools,'编辑资料',()=>editEntity(group,id));btn(tools,'按剧情更新此项',()=>run('update',{group,id}));btn(tools,'锁定字段',()=>editLocks(group,id));btn(tools,'删除并预览关联影响',()=>{const t=api.capture();api.stage(deleteEntity(t.doc,group,id),t,{manual:true});render();});}
  const metrics=card('实力与资源 / 自定义指标');
  for(const m of e.metrics){const row=el('div','','amin-org-row');row.append(el('strong',m.label),el('span',(m.kind==='unknown'?'未知':m.kind==='range'?m.value.join('—'):String(m.value))+(m.unit?' '+m.unit:'')),el('small',m.source||'依据未明确'));metrics.append(row);}
  if(!e.metrics.length)metrics.append(el('p','未记录指标；不会自动填入评分。'));
  const current=card('当前状态');for(const k of ['status','affairs','goals','leadership','ideology','capabilities'])if(k in e){current.append(el('h4',FIELDS[group][k]),el('p',e[k]||'未明确'));}
  const detail=el('details');detail.append(el('summary','详细档案与资料依据'));body.append(detail);
  for(const[k,label]of Object.entries(FIELDS[group]))if(!['name','summary','status','affairs','goals','leadership','ideology','capabilities'].includes(k)){detail.append(el('h4',label),el('p',e[k]||'未明确'));}
  const links=card('关联资料');
  const key=group==='organizations'?'relations':group==='alliances'?'members':'controllers';
  for(const l of e[key]){const row=el('div','','amin-org-row');btn(row,doc.organizations[l.organization]?.name??l.organization,()=>{selected='organizations';chosen.organizations=l.organization;render();});row.append(el('span',l.role+' · '+l.note));links.append(row);}
  if(group==='regions'&&e.parent)btn(links,'上级地区：'+doc.regions[e.parent].name,()=>{chosen.regions=e.parent;render();});
  if(group==='organizations'){
   for(const [aid,a]of Object.entries(doc.alliances))if(a.members.some(m=>m.organization===id))btn(links,'联盟：'+a.name,()=>{selected='alliances';chosen.alliances=aid;render();});
   for(const [rid,r]of Object.entries(doc.regions))if(r.controllers.some(m=>m.organization===id))btn(links,'地区：'+r.name,()=>{selected='regions';chosen.regions=rid;render();});
  }
 }
 function editLocks(group,id){
  const doc=api.read(),e=doc[group][id],c=draftStart('锁定字段 · '+e.name),all=api.locks(),checks={};
  c.append(el('p','锁定后AI和日常变量更新不得修改这些字段。你仍可通过手动编辑明确修改。'));
  for(const k of Object.keys(e))checks[k]=check(c,FIELDS[group][k]??LINKS[group][k]??'指标',all.includes([group,id,k].join('.')));
  const t=api.capture();btn(c,'保存锁定设置',async()=>{api.check(t);await api.setLocks([...all.filter(p=>!p.startsWith(group+'.'+id+'.')),...Object.entries(checks).filter(([,i])=>i.checked).map(([k])=>[group,id,k].join('.'))]);editing=false;render();say('锁定设置已保存；日常提示词请重新同步世界书');},true);btn(c,'取消',cancelEdit);
 }
 function editEntity(group,id){
  const token=api.capture(),doc=token.doc,original=id?doc[group][id]:entity(group,''),f=draftStart((id?'编辑':'新增')+LABELS[group]),inputs={};
  for(const[k,label]of Object.entries(FIELDS[group]))inputs[k]=field(f,label,original[k],!['name','type','certainty','updatedAt'].includes(k));
  const metricBox=card('自定义指标',f),metricRows=[];
  const addMetric=(m={key:uid(),label:'',kind:'unknown',value:null,unit:'',source:''})=>{
   const row=el('div','','amin-org-editor-row');metricBox.append(row);
   const label=field(row,'指标名称',m.label),key=field(row,'指标标识（跨组织排行需一致）',m.key),kind=select(row,'指标类型',[['unknown','未知'],['number','明确数字'],['range','范围'],['text','文字／等级']],m.kind),value=field(row,'值（范围用 最小,最大）',Array.isArray(m.value)?m.value.join(','):m.value??''),unit=field(row,'单位',m.unit),source=field(row,'依据',m.source);
   const record={row,label,key,kind,value,unit,source,removed:false};metricRows.push(record);btn(row,'移除此指标',()=>{record.removed=true;row.remove();});
  };
  original.metrics.forEach(addMetric);btn(metricBox,'增加指标',()=>addMetric());
  const linkKey=group==='organizations'?'relations':group==='alliances'?'members':'controllers',linkBox=card(LINKS[group][linkKey],f),linkRows=[];
  const choices=Object.entries(doc.organizations).filter(([oid])=>group!=='organizations'||oid!==id).map(([oid,e])=>[oid,e.name]);
  const addLink=(l={})=>{if(!choices.length)throw Error('请先建立可关联的组织');const row=el('div','','amin-org-editor-row');linkBox.append(row);const organization=select(row,'关联组织',choices,l.organization),role=field(row,'关系/身份/权利性质',l.role??''),note=field(row,'说明',l.note??'',true);const record={row,organization,role,note,removed:false};linkRows.push(record);btn(row,'移除此关联',()=>{record.removed=true;row.remove();});};
  original[linkKey].forEach(addLink);btn(linkBox,'增加关联',()=>addLink());
  const parent=group==='regions'?select(f,'上级地区',[['','无'],...Object.entries(doc.regions).filter(([rid])=>rid!==id).map(([rid,r])=>[rid,r.name])],original.parent??''):null;
  btn(f,'预览保存',()=>{
   api.check(token);const next=clone(doc),e=entity(group,inputs.name.value);
   for(const[k,input]of Object.entries(inputs))e[k]=input.value;
   e.metrics=metricRows.filter(r=>!r.removed).map(r=>{const kind=r.kind.value,raw=r.value.value.trim();if(['number','range'].includes(kind)&&!raw)throw Error('数字指标不能留空，请选择未知');return {key:r.key.value.trim(),label:r.label.value.trim(),kind,value:kind==='unknown'?null:kind==='number'?Number(raw):kind==='range'?raw.split(/[,，]/).map(n=>n.trim()?Number(n):NaN):raw,unit:r.unit.value,source:r.source.value};});
   e[linkKey]=linkRows.filter(r=>!r.removed).map(r=>({organization:r.organization.value,role:r.role.value,note:r.note.value}));if(parent)e.parent=parent.value||null;
   next[group][id??uid()]=e;api.stage(next,token,{manual:true});editing=false;render();
  },true);btn(f,'取消',cancelEdit);
 }
 function drawAssessment(a,parent=body){
  const c=card(a.title||'AI评估',parent);c.append(el('p','口径：'+a.criteria),el('p',a.summary),el('p','局限：'+a.limitations));
  const doc=api.read();for(const row of a.rows??[]){const item=card((row.rank==null?'未排名':row.rank+'名')+' · '+(doc[row.group]?.[row.id]?.name??row.id),c);for(const[k,label]of Object.entries({assessment:'结论',basis:'依据',strengths:'优势',weaknesses:'短板',confidence:'资料充分程度'}))item.append(el('p',label+'：'+row[k]));}
 }
 function assessmentPage(doc){
  const c=card('user专用评估');c.append(el('p','AI评估不是剧情事实，不默认注入日常聊天。明确数值排行与AI判断分开展示。'));
  if(historyIndex===null)btn(c,'生成／刷新AI评估',()=>run('assessment'));
  const a=historyIndex===null?api.assessment():api.history().find(r=>r.index===historyIndex)?.state?.assessment;
  if(a){c.append(el('p',(a.stale?'资料已变化，评估待刷新。 ':'')+'评估时间：'+new Date(a.at).toLocaleString()));drawAssessment(a);}else c.append(el('p','尚无评估，可在生成与规则里设置比较范围与口径。'));
  const rank=card('按明确指标排序');const g=select(rank,'主体类型',GROUPS.map(g=>[g,LABELS[g]]),'organizations'),key=field(rank,'指标标识',''),unit=field(rank,'比较单位',''),ascending=check(rank,'从小到大',false),result=el('div');rank.append(result);
  btn(rank,'查看数值排行',()=>{result.replaceChildren();const r=rankMetrics(doc,{group:g.value,key:key.value,unit:unit.value,ascending:ascending.checked});for(const row of r.included)result.append(el('p',row.rank+' · '+row.name+'：'+row.value+' '+unit.value));for(const row of r.excluded)result.append(el('small',row.name+'：未参与（'+row.reason+'）'));if(!r.included.length)result.append(el('p','没有同标识、同单位的明确数值，未生成排行。'));});
 }
 function settingsPage(){
  editing=true;const token=api.capture(),cfg=api.config(),f=card('生成范围与资料来源');
  const scope=field(f,'整理范围',cfg.scope,true),detail=select(f,'详细程度',[['简略','简略'],['标准','标准'],['详细','详细']],cfg.detail),groups={};
  for(const g of GROUPS)groups[g]=check(f,'包括'+LABELS[g],cfg.groups.includes(g));
  const includeCharacter=check(f,'读取当前角色设定',cfg.includeCharacter),includeChat=check(f,'读取已加载的最近20条非系统消息',cfg.includeChat),books=field(f,'世界书名称（每行一本；留空则不读取）',cfg.books,true),allowInference=check(f,'允许合理推演（必须标记）',cfg.allowInference),allowNew=check(f,'剧情更新允许新增主体',cfg.allowNew);
  f.append(el('p','按钮只读取上述选定素材；不会自动查询未加载历史。规则和选项按角色保存，聊天资料仍彼此隔离。'));
  const rules={};for(const[k,label]of [['generation','生成／补充规则'],['update','剧情更新规则'],['assessment','评估规则']]){const c=card(label);rules[k+'Enabled']=check(c,'启用',cfg[k+'Enabled']);rules[k+'Rules']=field(c,'要求',cfg[k+'Rules'],true);}
  const follow=card('小白X变量管理2.0联动'),followEnabled=check(follow,'启用日常剧情变量更新（保存后需同步世界书）',cfg.follow);
  const mode=api.context()?.extensionSettings?.LittleWhiteBox?.variablesMode;follow.append(el('p','当前检测到的变量模式：'+(mode??'未检测到')+'。按钮生成与手动编辑不依赖日常联动开关。'));
  follow.append(el('p','同步只操作本应用拥有的世界书条目；关闭后再次同步会禁用该条目。多个角色共用世界书时会共用最后同步的规则，请使用独立世界书。锁定或规则修改后请重新同步。'));
  btn(follow,'复制已保存的更新提示词',async()=>{const text=followPrompt(api.config(),api.locks());if(globalThis.navigator?.clipboard?.writeText){await navigator.clipboard.writeText(text);say('已复制，不会自动发送');}else{field(follow,'手动复制',text,true);}});
  btn(follow,'同步已保存规则到世界书',async()=>{api.check(token);const r=await syncWorldbook(api);say(r.name+'：'+r.action+(r.warning?' · '+r.warning:''));});
  const tools=el('div','','amin-toolbar');body.append(tools);
  btn(tools,'保存生成与规则设置',async()=>{api.check(token);const next={...cfg,scope:scope.value,detail:detail.value,groups:GROUPS.filter(g=>groups[g].checked),includeCharacter:includeCharacter.checked,includeChat:includeChat.checked,books:books.value,allowInference:allowInference.checked,allowNew:allowNew.checked,follow:followEnabled.checked};if(!next.groups.length)throw Error('至少选择一种资料类型');for(const[k,input]of Object.entries(rules))next[k]=k.endsWith('Enabled')?input.checked:input.value;await api.saveConfig(next);editing=false;selected='overview';render();say('规则已保存；日常联动请另行同步世界书');},true);
  btn(tools,'取消',()=>{selected='overview';cancelEdit();});
 }
 function render(){
  if(disposed)return;
  body.replaceChildren();tabs.replaceChildren();drawHeader();
  try{
   lastIdentity=chatIdentity(api.context());
   for(const[k,label]of Object.entries(tabsMap)){if(historyIndex!==null&&k==='settings')continue;const b=btn(tabs,label,()=>navigate(k));b.setAttribute('role','tab');b.setAttribute('aria-selected',String(selected===k));}
   const pending=api.pending();if(pending&&historyIndex===null){drawPreview(pending);return;}
   let doc=api.read();
   if(historyIndex!==null){const r=api.history().find(r=>r.index===historyIndex);if(!r?.available)throw Error('该楼层没有资料记录');doc=r.state.doc;}
   if(selected==='overview')drawOverview(doc);else if(GROUPS.includes(selected))drawGroup(doc,selected);else if(selected==='assessment')assessmentPage(doc);else settingsPage();
  }catch(e){say(e.message);body.append(el('p','请打开聊天，或检查变量资料格式。不会覆盖无效的现有资料。'));}
 }
 const unsubscribe=api.subscribe(()=>{
  if(disposed)return;try{const id=chatIdentity(api.context());if(lastIdentity!==id){editing=false;historyIndex=null;lastIdentity=id;render();return;}}catch{editing=false;historyIndex=null;render();return;}
  if(api.error())say(api.error());
  if(!editing)render();else if(!api.pending())say(api.error()||'资料可能已更新；表单草稿保留，保存时会检查冲突。');
 });
 const handle={open(){if(!editing)render();},dispose(){disposed=true;unsubscribe();page.remove();if(mounted.get(target)===handle)mounted.delete(target);}};
 mounted.set(target,handle);render();return handle;
}
