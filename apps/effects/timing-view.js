const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const MAX_MINUTES=5256000;

export function durationInMinutes(amount,unit='minutes'){
 const factors={minutes:1,hours:60,days:1440};
 const value=Number(amount),factor=factors[unit];
 if(!factor||!String(amount).trim()||!Number.isInteger(value)||value<1)throw Error('持续时长需填写正整数，并选择分钟、小时或天');
 const minutes=value*factor;
 if(!Number.isSafeInteger(minutes)||minutes>MAX_MINUTES)throw Error('持续时长不能超过 5256000 分钟');
 return minutes;
}

export function durationFields(parent,{effect=null,clock=null,onChange=()=>{}}={}){
 const box=node('section',null,'amin-stack amin-span-full');
 const grid=node('div',null,'amin-form-grid');
 const row=node('label','计时方式','amin-field'),mode=node('select');mode.setAttribute('aria-label','计时方式');
 const options=effect?[['keep','保留现有计时'],['set','重新设置时长（从当前游戏时间开始）'],['none','不按时间到期']]:[['none','不按时间到期'],['set','按游戏时间计时']];
 for(const [value,text]of options){const o=node('option',text);o.value=value;mode.append(o);}mode.value=effect?'keep':'none';row.append(mode);grid.append(row);
 const timeRow=node('label','持续时长','amin-field'),amount=node('input');amount.type='number';amount.min='1';amount.step='1';amount.value=String(effect?.timing?.durationMinutes??60);amount.setAttribute('aria-label','持续时长');timeRow.append(amount);grid.append(timeRow);
 const unitRow=node('label','时长单位','amin-field'),unit=node('select');unit.setAttribute('aria-label','时长单位');for(const [value,text]of [['minutes','分钟'],['hours','小时'],['days','天']]){const o=node('option',text);o.value=value;unit.append(o);}unit.value='minutes';unitRow.append(unit);grid.append(unitRow);
 const note=node('p',null,'amin-meta');note.textContent=clock?'计时以场景中的游戏时间为准；暂停时冻结剩余时长。':'当前没有游戏时间。先在“场景与时间”设置时间，才能创建或重设限时效果。';
 const preview=node('p',null,'amin-meta');preview.setAttribute('aria-live','polite');
 box.append(grid,note,preview);parent.append(box);
 const reflect=()=>{timeRow.hidden=unitRow.hidden=mode.value!=='set';preview.textContent='';if(mode.value==='set'){try{preview.textContent='总计 '+durationInMinutes(amount.value,unit.value)+' 分钟';}catch(e){preview.textContent=e.message;}}};
 for(const input of [mode,amount,unit])input.addEventListener(input===amount?'input':'change',()=>{reflect();onChange();});reflect();
 return {element:box,read(){if(mode.value==='keep')return undefined;if(mode.value==='none')return null;if(!clock)throw Error('请先在“场景与时间”设置游戏时间，再使用限时效果');return durationInMinutes(amount.value,unit.value);}};
}

export function timingLabel(effect){
 const status=effect.timingStatus;
 if(status?.state==='expired')return '已到期 · 暂不附加剧情提醒';
 if(status?.state==='unknown')return '计时待确认 · 游戏时间不可用';
 if(effect.paused)return '已暂停 · 暂不附加剧情提醒';
 return '生效中 · 后续生成附加提醒';
}

export function appendTiming(parent,effect){
 if(!effect.timing)return;
 const status=effect.timingStatus??{state:'unknown',label:'游戏时间不可用'};
 const line=node('p',null,'amin-meta');line.dataset.timingState=status.state;
 line.textContent='限时效果 · '+(status.label||({active:'计时中',paused:'已暂停',expired:'已到期',unknown:'游戏时间不可用'}[status.state]??''));
 if(Number.isFinite(status.remainingMinutes)&&!line.textContent.includes('剩余'))line.textContent+=' · 剩余 '+status.remainingMinutes+' 分钟';
 if(Number.isInteger(effect.timing.durationMinutes))line.textContent+=' · 设定 '+effect.timing.durationMinutes+' 分钟';
 parent.append(line);
}
