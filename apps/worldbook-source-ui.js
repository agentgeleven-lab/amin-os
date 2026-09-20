import {worldbookChoices,resolvedBookNames} from './worldbook-sources.js';
// Source-selection UI only: never loads entry bodies, generates, or writes a worldbook.
export function mountWorldbookSources(parent,{context,value={},onChange=()=>{},disabled=false,sourceOptions={}}={}){
 const doc=parent.ownerDocument,root=doc.createElement('section');root.className='amin-worldbook-sources';parent.append(root);
 const initial=context(),metadata=initial.chatMetadata,chatId=initial.getCurrentChatId?.(),avatar=initial.characters?.[initial.characterId]?.avatar,group=initial.groupId;
 let disposed=false,ready=false,revision=0,choices=[],state={includeCharacter:value.includeCharacter!==false,readWorldbooks:value.readWorldbooks!==false,...Object.fromEntries(['selectedBooks','legacyBindings','includeGlobalBooks','includeGlobal','extraBooks','books'].filter(k=>Object.hasOwn(value,k)).map(k=>[k,structuredClone(value[k])]))};
 const guard=()=>{const c=context();if(disposed||c.chatMetadata!==metadata||c.getCurrentChatId?.()!==chatId||c.groupId!==group||c.characters?.[c.characterId]?.avatar!==avatar)throw Error('聊天已切换，请重新打开生成设置');};
 const checkbox=(text,checked,parent=root)=>{const label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.checked=checked;input.disabled=disabled;input.setAttribute('aria-label',text);label.append(doc.createTextNode(text),input);parent.append(label);return input;};
 const character=checkbox('读取当前角色设定（含绑定世界书）',state.includeCharacter!==false),enabled=checkbox('是否读取世界书',state.readWorldbooks!==false);
 const note=doc.createElement('p');note.textContent='每次AI操作重新读取最新正文；关闭总开关不读取任何书。只读启用条目，忽略关键词等激活策略，不限制素材字符数。';root.append(note);
 const refreshButton=doc.createElement('button');refreshButton.type='button';refreshButton.textContent='刷新已启用世界书列表';refreshButton.disabled=disabled;root.append(refreshButton);
 const report=doc.createElement('p'),list=doc.createElement('div');report.setAttribute('role','status');root.append(report,list);
 function changed(){guard();onChange(structuredClone(state));}
 function draw(){list.replaceChildren();const selected=resolvedBookNames(state,choices),available=new Set(choices.map(b=>b.name));for(const b of [...choices,...selected.filter(n=>!available.has(n)).map(name=>({name,sources:['当前未启用，请取消选择或先启用'],automatic:false}))]){const automatic=state.includeCharacter!==false&&b.automatic,input=checkbox(b.name+(automatic?'（随角色自动读取）':'')+' · '+b.sources.join('、'),automatic||selected.includes(b.name),list);input.dataset.worldbook=b.name;input.disabled=disabled||!ready||!enabled.checked||automatic;input.onchange=()=>{try{guard();if(!ready){draw();return;}const next=new Set(resolvedBookNames(state,choices));if(input.checked)next.add(b.name);else next.delete(b.name);state.selectedBooks=[...next];changed();}catch(e){report.textContent=e.message;}};}}
 character.onchange=()=>{try{guard();state.includeCharacter=character.checked;changed();draw();}catch(e){report.textContent=e.message;}};
 enabled.onchange=()=>{try{guard();state.readWorldbooks=enabled.checked;changed();draw();}catch(e){report.textContent=e.message;}};
 async function refresh(){const own=++revision;report.textContent='正在读取当前启用列表（不读取正文）…';try{const result=await worldbookChoices(context(),{...sourceOptions,check:guard});guard();if(own!==revision)return;choices=result;state.selectedBooks=resolvedBookNames(state,choices);ready=true;report.textContent=choices.length?'当前启用的世界书；自动绑定书与勾选书会去重。':'当前没有已启用的世界书。';draw();}catch(e){if(!disposed&&own===revision)report.textContent=e.message;}}
 refreshButton.onclick=refresh;draw();void refresh();
 return {getValue(){guard();return structuredClone(state);},refresh,dispose(){disposed=true;revision++;root.remove();}};
}
