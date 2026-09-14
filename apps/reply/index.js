import { normalizeSettings, chatStamp, collectContext, generateOptions, inputElement, DraftSelection, waitForResult } from './generator.js';
const KEY='reply_options_mvp';
const context=()=>globalThis.SillyTavern?.getContext?.();
const node=(tag,text,cls)=>{const n=document.createElement(tag); if(text)n.textContent=text;if(cls)n.className=cls;return n;};
export function mount({ target } = {}) {
    if(document.getElementById('reply-options-panel'))return;
    const ctx=context(), form=document.querySelector('#send_form');if(!ctx||!form)return;
    let settings=normalizeSettings(ctx.extensionSettings?.[KEY]), revision=0, controller=null;
    const draft=new DraftSelection();
    const panel=node('details');panel.id='reply-options-panel';panel.open=target ? true : settings.expanded;
    panel.append(node('summary','回复选项'));
    const controls=node('div',null,'ro-controls'), cards=node('div',null,'ro-options'), status=node('div','点击生成，选择后填入，由你发送。','ro-status');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const button=(label,fn,parent=controls)=>{const b=node('button',label,'menu_button');b.type='button';b.addEventListener('click',fn);parent.append(b);return b;};
    const generate=button('生成选项',()=>run(false)), expand=button('根据草稿扩写',()=>run(true));
    const cancel=button('停止等待',()=>controller?.abort());cancel.hidden=true;
    const undo=button('撤销填入',()=>{try{draft.undo(inputElement());status.textContent='已还原原草稿。';updateSelection();}catch(e){status.textContent=e.message;}});
    button('保留编辑',()=>{draft.reset();updateSelection();status.textContent='已保留输入框现有内容；下次选择将以它为原草稿。';});
    const settingsBox=node('div');settingsBox.id='reply-options-settings';settingsBox.className='ro-settings';settingsBox.hidden=true;
    function save(){const c=context();if(c?.extensionSettings){c.extensionSettings[KEY]={...settings};c.saveSettingsDebounced?.();}}
    function invalidate(message='上下文已更新，请重新生成。',reset=false){revision++;controller?.abort();cards.replaceChildren();if(reset)draft.reset();updateSelection();status.textContent=message;}
    function field(key,label,type,options){
        const row=node('label'), title=node('span',label);row.append(title);
        const el=node(type==='textarea'?'textarea':options?'select':'input');el.setAttribute('aria-label',label);
        if(options)for(const [value,text] of options){const o=node('option',text);o.value=value;el.append(o);}
        if(type==='checkbox'){el.type='checkbox';el.checked=settings[key];}else {if(type==='number'){el.type='number';el.min=key==='count'?2:key==='timeout'?15:1;el.max=key==='count'?6:key==='timeout'?300:40;}el.value=settings[key];}
        if(key==='thirdPersonName'){el.type='text';el.maxLength=100;el.placeholder='留空：参考上文中的用户角色名字';}
        if(type==='textarea')el.maxLength=key==='prompt'?4000:600;
        el.addEventListener('change',()=>{settings=normalizeSettings({...settings,[key]:type==='checkbox'?el.checked:el.value});if(type!=='checkbox')el.value=settings[key];save();invalidate('设置已保存，请重新生成。');});row.append(el);settingsBox.append(row);
    }
    field('count','选项数量','number');field('depth','最近聊天条数','number');field('timeout','等待上限（秒）','number');
    field('length','回复长度','select',[['short','短：约 1 句'],['medium','中：1–3 句'],['long','长：3–6 句']]);
    field('style','回复形式','select',[['mixed','对白与动作'],['dialogue','仅对白'],['action','动作描写为主']]);
    field('perspective','叙述人称','select',[['auto','跟随上文'],['first','第一人称：我'],['second','第二人称：你'],['third','第三人称：名字']]);
    field('thirdPersonName','第三人称名字（仅第三人称生效）','text');
    field('mode','普通生成填入方式','select',[['append','保留原草稿，切换候选'],['replace','替换原草稿，支持撤销']]);
    field('persona','参考用户人设','checkbox');field('character','参考角色设定（含绑定世界书）','checkbox');field('world','参考激活的全体世界书','checkbox');
    field('directions','选项方向（每行一个，按数量随机抽取）','textarea');field('prompt','自定义生成要求','textarea');
    settingsBox.append(node('p','第三人称名字留空时参考上文，无法识别时使用当前用户名称；自定义名字优先。对白中的人称按语义保留。方向少于选项数量时允许重复抽取；方向足够时不重复抽取。重复方向仍生成不同回复。草稿扩写会用候选替换原草稿，可撤销。角色设定包含绑定世界书；全体世界书包含当前全局启用及角色、聊天、人设绑定的书。读取全部未禁用的非空条目，不要求关键词触发。'));
    const settingsButton=button('设置',()=>{settingsBox.hidden=!settingsBox.hidden;settingsButton.setAttribute('aria-expanded',String(!settingsBox.hidden));});
    settingsButton.setAttribute('aria-controls','reply-options-settings');
    settingsButton.setAttribute('aria-expanded','false');
    panel.append(controls,settingsBox,status,cards);if(target){target.append(panel);panel.classList.add("amin-reply-embedded");}else form.before(panel);
    panel.addEventListener('toggle',()=>{if(!target){settings.expanded=panel.open;save();}});
    function updateSelection(){undo.disabled=draft.base===null;for(const b of cards.children)b.setAttribute('aria-pressed','false');}
    updateSelection();
    function setBusy(value){generate.disabled=value;expand.disabled=value;cancel.hidden=!value;generate.textContent=value?'生成中…':'生成 / 换一批';}
    async function run(fromDraft){
        if(controller)return;
        let initial, stamp, config, ticket, original;
        try{initial=context();stamp=chatStamp(initial);config={...settings};original=inputElement().value;if(fromDraft&&!original.trim())throw new Error('先在输入框写下草稿或回复意图。');}catch(e){status.textContent=e.message;return;}
        if(fromDraft)draft.reset();updateSelection();cards.replaceChildren();ticket=++revision;const current=new AbortController();controller=current;setBusy(true);
        let sources='正在读取世界书…';
        status.textContent=sources;
        try{
            const options=await waitForResult(generateOptions(initial,config,{draft:fromDraft?original:'',isCurrent:()=>!current.signal.aborted && ticket===revision && stamp===chatStamp(context()),onContext:(info,lore)=>{sources=`人设：${info.persona?'已读取':'未使用/为空'}；角色：${info.characters.length}；世界书：${lore.books.length} 本 / ${info.world.length} 条`;status.textContent=`生成中… ${sources}`;}}),config.timeout*1000,current.signal);
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
    const on=(name,fn)=>{if(events[name])ctx.eventSource?.on(events[name],fn);};
    for(const event of ['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','PERSONA_CHANGED','CHARACTER_EDITED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'])on(event,()=>{
        invalidate(undefined,['CHAT_CHANGED','MESSAGE_SENT'].includes(event));
    });
}
