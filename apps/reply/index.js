import {getAI} from '../../ai/service.js';
import { CONTENT_MODES, normalizeSettings, chatStamp, collectContext, generateOptions, inputElement, DraftSelection, waitForResult } from './generator.js';
const KEY='reply_options_mvp';
const context=()=>globalThis.SillyTavern?.getContext?.();
const node=(tag,text,cls)=>{const n=document.createElement(tag); if(text)n.textContent=text;if(cls)n.className=cls;return n;};
export function mount({target,instanceId='reply-options-panel',contextProvider,headingText} = {}) {
    const context=()=>{const ctx=globalThis.SillyTavern?.getContext?.();return contextProvider&&ctx?contextProvider(ctx):ctx;};
    const settingsId=instanceId==='reply-options-panel'?'reply-options-settings':instanceId+'-settings';
    const removers=[];
    if(document.getElementById(instanceId))return;
    const ctx=context(), form=document.querySelector('#send_form');if(!ctx||!form)return;
    let settings=normalizeSettings(ctx.extensionSettings?.[KEY]), revision=0, controller=null;
    const draft=new DraftSelection();
    const panel=node('details');panel.id=instanceId;panel.className='ro-panel';panel.open=target ? true : settings.expanded;
    panel.append(node('summary','回复选项'));
    const controls=node('div',null,'ro-controls'), cards=node('div',null,'ro-options'), status=node('div','点击生成，选择后填入，由你发送。','ro-status');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const button=(label,fn,parent=controls)=>{const b=node('button',label,'menu_button');b.type='button';b.addEventListener('click',fn);parent.append(b);return b;};
    const generate=button('生成选项',()=>run(false)), expand=button('根据草稿扩写',()=>run(true));
    const cancel=button('停止等待',()=>controller?.abort());cancel.hidden=true;
    const undo=button('撤销填入',()=>{try{draft.undo(inputElement());status.textContent='已还原原草稿。';updateSelection();}catch(e){status.textContent=e.message;}});
    button('保留编辑',()=>{draft.reset();updateSelection();status.textContent='已保留输入框现有内容；下次选择将以它为原草稿。';});
    const settingsBox=node('div');settingsBox.id=settingsId;settingsBox.className='ro-settings';settingsBox.hidden=true;
    function save(){const c=context();if(c?.extensionSettings){c.extensionSettings[KEY]={...settings};c.saveSettingsDebounced?.();}}
    function invalidate(message='上下文已更新，请重新生成。',reset=false){revision++;controller?.abort();cards.replaceChildren();if(reset)draft.reset();updateSelection();status.textContent=message;}
    const fieldRows=new Map();
    function field(key,label,type,options){
        const row=node('label'), title=node('span',label);row.append(title);fieldRows.set(key,row);
        const el=node(type==='textarea'?'textarea':options?'select':'input');el.setAttribute('aria-label',label);
        if(options)for(const [value,text] of options){const o=node('option',text);o.value=value;el.append(o);}
        if(type==='checkbox'){el.type='checkbox';el.checked=settings[key];}else {if(type==='number'){el.type='number';el.min=key==='count'?2:key==='timeout'?15:1;el.max=key==='count'?6:key==='timeout'?300:40;}el.value=settings[key];}
        if(key==='subjectName'){el.type='text';el.maxLength=100;el.placeholder='填写任意剧情角色名字；留空使用当前用户角色';}
        if(type==='textarea')el.maxLength=[...CONTENT_MODES.map(m=>m.key),'authorSystemPrompt','roleplaySystemPrompt'].includes(key)?8000:4000;
        el.addEventListener('change',()=>{settings=normalizeSettings({...settings,[key]:type==='checkbox'?el.checked:el.value});if(type!=='checkbox')el.value=settings[key];save();invalidate('设置已保存，请重新生成。');});row.append(el);settingsBox.append(row);
    }
    function directionsEditor(key,rowKey,title){
        const box=node('section',null,'ro-direction-list');fieldRows.set(rowKey,box);settingsBox.append(box);
        const persist=()=>{settings=normalizeSettings({...settings,[key]:settings[key]});save();invalidate('方向已保存，请重新生成。');};
        function draw(){box.replaceChildren();box.append(node('strong',title));for(const item of settings[key]){
            const row=node('div',null,'ro-direction-item'),toggle=node('input'),text=node('input');toggle.type='checkbox';toggle.checked=item.enabled;toggle.setAttribute('aria-label','启用'+title+'：'+(item.text||'未命名'));text.value=item.text;text.maxLength=600;text.setAttribute('aria-label',title+'内容');
            toggle.addEventListener('change',()=>{settings[key].find(v=>v.id===item.id).enabled=toggle.checked;persist();draw();});text.addEventListener('change',()=>{settings[key].find(v=>v.id===item.id).text=text.value;persist();draw();});row.append(toggle,text);button('删除',()=>{settings[key]=settings[key].filter(v=>v.id!==item.id);persist();draw();},row);box.append(row);
        }button('添加'+title,()=>{settings[key].push({id:crypto.randomUUID(),text:'',enabled:true});persist();draw();},box);box.append(node('p','仅抽取启用且非空的方向；全部禁用时不会请求模型。'));}
        draw();
    }
    if(getAI())button('AI 设置 · 全局 API 与预设',()=>globalThis.AminOS?.openApp('ai'),settingsBox);
    field('count','选项数量','number');field('depth','最近聊天条数','number');
    field('length','选项长度','select',[['short','短：约 1 句'],['medium','中：1–3 句'],['long','长：3–6 句']]);
    field('style','回复形式','select',[['mixed','对白与动作'],['dialogue','仅对白'],['action','动作描写为主']]);
    field('perspective','叙述人称','select',[['auto','跟随上文'],['first','第一人称：我'],['second','第二人称：你'],['third','第三人称：名字']]);
    field('subjectName','回复主体（任意剧情角色，所有人称生效）','text');
    field('mode','普通生成填入方式','select',[['append','保留原草稿，切换候选'],['replace','替换原草稿，支持撤销']]);
    field('persona','参考用户人设','checkbox');field('character','参考角色设定（含绑定世界书）','checkbox');field('world','参考激活的全体世界书','checkbox');
    field('roleplaySystemPrompt','角色扮演模式提示词（角色定位）','textarea');
    directionsEditor('directionItems','directions','选项方向');field('prompt','自定义生成要求','textarea');
    directionsEditor('authorDirectionItems','authorDirections','剧情方向');
    field('authorSystemPrompt','剧情模式提示词（作者 / 编剧定位）','textarea');for(const style of CONTENT_MODES)field(style.key,style.name+'提示词（两种创作模式共用）','textarea');field('authorPrompt','作者要求（节奏、冲突、伏笔、希望避免的走向等）','textarea');
    const roleHelp=node('p','回复主体可填写任意剧情角色的名字，不限于玩家或当前角色卡。留空使用当前用户角色；旧第三人称名字会迁移为主体。对白中的人称按语义保留。方向少于选项数量时允许重复抽取；方向足够时不重复抽取。重复方向仍生成不同回复。草稿扩写会用候选替换原草稿，可撤销。角色设定包含绑定世界书；全体世界书包含当前全局启用及角色、聊天、人设绑定的书。读取全部未禁用的非空条目，不要求关键词触发。');settingsBox.append(roleHelp);
    const settingsButton=button('设置',()=>{settingsBox.hidden=!settingsBox.hidden;settingsButton.setAttribute('aria-expanded',String(!settingsBox.hidden));});
    settingsButton.setAttribute('aria-controls',settingsId);
    settingsButton.setAttribute('aria-expanded','false');
    if(target){const heading=node('header',null,'amin-reply-heading');heading.append(node('h2',headingText||'下一句，由你决定'),node('p','生成候选或扩写草稿，选中后填入聊天。'));panel.append(heading);}
    const modeRow=node('label',null,'ro-writing-mode'),modeSelect=node('select'),modeHelp=node('p',null,'ro-status');modeRow.append(node('span','创作模式'));modeSelect.setAttribute('aria-label','创作模式');for(const [value,label]of [['roleplay','角色扮演 · 拟写角色回复'],['author','创意写作 · 规划剧情走向']]){const option=node('option',label);option.value=value;modeSelect.append(option);}modeRow.append(modeSelect);
    function reflectMode(){const author=settings.writingMode==='author';roleHelp.hidden=author;modeSelect.value=settings.writingMode;for(const key of ['style','perspective','subjectName','directions','prompt','roleplaySystemPrompt'])fieldRows.get(key).hidden=author;for(const key of ['authorDirections','authorPrompt','authorSystemPrompt'])fieldRows.get(key).hidden=!author;expand.textContent=author?'展开作者构想':'根据草稿扩写';modeHelp.textContent=author?'以作者 / 编剧视角选择下一步事件、冲突与转折。选中后填入作者指令，不自动发送。':'以指定剧情角色为主体生成对白与行动。选中后填入输入框，不自动发送。';const heading=panel.querySelector('.amin-reply-heading h2');if(heading)heading.textContent=author?'接下来，故事怎么走':headingText||'下一句，由你决定';}
    modeSelect.onchange=()=>{settings=normalizeSettings({...settings,writingMode:modeSelect.value});save();invalidate('模式已切换，请重新生成。');reflectMode();};
    const contentRow=node('label',null,'ro-writing-mode'),contentSelect=node('select');contentSelect.setAttribute('aria-label','内容风格');contentRow.append(node('span','内容风格'),contentSelect);for(const style of CONTENT_MODES){const option=node('option',style.name);option.value=style.id;contentSelect.append(option);}
    function reflectContent(){contentSelect.value=settings.contentMode;for(const style of CONTENT_MODES)fieldRows.get(style.key).hidden=style.id!==settings.contentMode;}
    contentSelect.addEventListener('change',()=>{settings=normalizeSettings({...settings,contentMode:contentSelect.value});save();reflectContent();const style=CONTENT_MODES.find(m=>m.id===settings.contentMode);invalidate(settings[style.key].trim()?'内容风格已保存，请重新生成。':'当前风格提示词为空，可在设置中填写；留空不追加要求。');});reflectContent();

    panel.append(modeRow,contentRow,modeHelp,controls,settingsBox,status,cards);reflectMode();if(target){target.append(panel);panel.classList.add("amin-reply-embedded");}else form.before(panel);
    panel.addEventListener('toggle',()=>{if(!target){settings.expanded=panel.open;save();}});
    function updateSelection(){undo.disabled=draft.base===null;for(const b of cards.children)b.setAttribute('aria-pressed','false');}
    updateSelection();
    function setBusy(value){generate.disabled=value;expand.disabled=value;cancel.hidden=!value;generate.textContent=value?'生成中…':'生成 / 换一批';}
    async function run(fromDraft){
        if(controller)return;
        let initial, stamp, config, ticket, original;
        try{initial=context();settings=normalizeSettings(initial?.extensionSettings?.[KEY]);stamp=chatStamp(initial);config={...settings};reflectMode();reflectContent();original=inputElement().value;if(fromDraft&&!original.trim())throw new Error(settings.writingMode==='author'?'先在输入框写下剧情构想或推进要求。':'先在输入框写下草稿或回复意图。');}catch(e){status.textContent=e.message;return;}
        if(fromDraft)draft.reset();updateSelection();cards.replaceChildren();ticket=++revision;const current=new AbortController();controller=current;setBusy(true);
        let sources='正在读取世界书…';
        status.textContent=sources;
        try{
            const options=await waitForResult(generateOptions(initial,config,{draft:fromDraft?original:'',signal:current.signal,isCurrent:()=>!current.signal.aborted && ticket===revision && stamp===chatStamp(context()),onContext:(info,lore)=>{sources=`人设：${info.persona?'已读取':'未使用/为空'}；角色：${info.characters.length}；世界书：${lore.books.length} 本 / ${info.world.length} 条`;status.textContent=`生成中… ${sources}`;}}),(getAI()?.capture().config.timeoutSeconds??config.timeout)*1000,current.signal);
            if(ticket!==revision||stamp!==chatStamp(context()))throw new Error('聊天已变化，本次结果已丢弃。');
            for(const option of options){const card=node('button',null,'ro-card');card.type='button';card.setAttribute('aria-pressed','false');card.append(node('strong',option.label),node('span',option.text));card.addEventListener('click',()=>{
                if(ticket!==revision||stamp!==chatStamp(context()))return invalidate();
                try{const input=inputElement();if(fromDraft&&draft.base===null&&input.value!==original)throw new Error('扩写期间草稿已改变，请重新扩写或使用普通生成。');draft.choose(input,option.text,fromDraft?'replace':config.mode);updateSelection();card.setAttribute('aria-pressed','true');status.textContent='已填入，尚未发送。可切换候选或撤销。';}catch(e){status.textContent=e.message;}
            });cards.append(card);}
            status.textContent=`${options.length} 个选项 · ${sources}`;
        }catch(e){if(ticket===revision)status.textContent=e.message||'生成失败，请检查模型连接。';}
        finally{if(controller===current){controller=null;setBusy(false);}}
    }
    const events=ctx.eventTypes||ctx.event_types||{};
    const on=(name,fn)=>{if(events[name]){ctx.eventSource?.on(events[name],fn);removers.push(()=>{const source=ctx.eventSource;if(source?.removeListener)source.removeListener(events[name],fn);else source?.off?.(events[name],fn);});}};
    for(const event of ['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','PERSONA_CHANGED','CHARACTER_EDITED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'])on(event,()=>{
        invalidate(undefined,['CHAT_CHANGED','MESSAGE_SENT'].includes(event));
    });
    return {dispose(){revision++;controller?.abort();for(const remove of removers)remove();panel.remove();}};
}
