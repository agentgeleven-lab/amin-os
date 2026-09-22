// Real DOM integration checks with fictional settings/chat and no model calls.
import {mount} from '../view.js';
import {getSharedService} from '../service.js';
import {KEY,activeEffects,compile} from '../model.js';
import {LIBRARY_KEY,abilityGroup,groupNames} from '../library.js';
import {installExtraFloorButtons} from '../../extra-floor-ui.js';
import {initializeAppearance,installAppearance} from '../../../settings/appearance.js';
const ensure=(value,message)=>{if(!value)throw Error(message);};
const label=(root,name)=>{const n=root.querySelector('[aria-label="'+name+'"]');ensure(n,'missing field '+name);return n;};
const set=(node,value)=>{node.value=value;node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
const click=async(root,text)=>{const b=[...root.querySelectorAll('button')].find(n=>n.textContent===text);ensure(b,'missing button '+text);await b.onclick();};
const card=(root,title)=>[...root.querySelectorAll('section.amin-card')].find(n=>n.querySelector('h3')?.textContent.startsWith(title));
export async function runAbilityChecks({managed=false}={}){
 const handlers=new Map(),participants=[],settings={};let failSave=false,saves=0;
 const original=[{id:'fire',name:'燃烧领域',book:'旧书',entryId:'1',original:'展开燃烧领域。',reminder:'按范围维持热量，主动解除。',ui:{group:'战斗',icon:'🔥'}},{id:'sense',name:'探知',book:'旧书',entryId:'2',original:'感知附近情况。',reminder:'保持感知。',ui:{group:'探索'}},{id:'old',name:'旧能力',book:'旧书',entryId:'3',original:'完整旧原文',reminder:'完整旧规则'}];
 const ctx={chatId:'ability-a',getCurrentChatId(){return this.chatId;},characterId:0,name1:'发动者',name2:'测试角色',characters:[{name:'测试角色',avatar:'fixture.png'}],
  chat:[{name:'我',mes:'虚构第一楼'},{name:'角色',mes:'虚构第二楼'}],chatMetadata:{[KEY]:{version:1,skills:original,events:[],enabled:true,limit:30000}},extensionSettings:settings,
  saveSettingsDebounced:async()=>{if(failSave)throw Error('模拟保存失败');saves++;},saveMetadata:async()=>{},setExtensionPrompt(){},
  eventTypes:{CHAT_CHANGED:'chat',GENERATION_AFTER_COMMANDS:'start',GENERATION_ENDED:'end',GENERATION_STOPPED:'stop',MESSAGE_DELETED:'deleted',MESSAGE_UPDATED:'updated',MESSAGE_SWIPED:'swiped'},
  eventSource:{on(k,fn){if(!handlers.has(k))handlers.set(k,new Set());handlers.get(k).add(fn);},removeListener(k,fn){handlers.get(k)?.delete(fn);}},
 };
 window.SillyTavern={getContext:()=>ctx};
 const emit=k=>{for(const fn of [...handlers.get(k)??[]])fn();};
 if(managed)window.__TAURITAVERN__={api:{chatSurface:{protocolVersion:1,isManagedOwnershipRequired:()=>true,registerParticipant:p=>participants.push(p)}}};
 initializeAppearance(()=>ctx);const skin=installAppearance(document);
 const app=document.getElementById('app'),view=mount(app),api=getSharedService();
 ensure(JSON.stringify(api.read().skills)===JSON.stringify(original),'migration changed old ability fields');
 ensure(groupNames(api.read()).join(',')==='未分组,战斗,探索','legacy groups missing');
 ensure(!app.querySelector('.amin-ability-grid'),'old flat button grid still visible');
 set(label(app,'能力分组'),'战斗');ensure(label(app,'选择能力').options.length===2,'group filter not applied');
 ensure(api.read().events.length===0,'selecting group caused activation');set(label(app,'选择能力'),'fire');
 await click(app,'发动所选能力');ensure(app.textContent.includes('请先填写目标角色'),'targeted mode did not require target');ensure(api.read().events.length===0,'invalid target wrote record');
 set(label(app,'目标角色'),'不应写入的旧目标');set(label(app,'发动方式'),'direct');ensure(label(app,'目标角色').parentElement.hidden&&getComputedStyle(label(app,'目标角色').parentElement).display==='none','direct mode still shows required target');
 await click(app,'发动所选能力');set(label(app,'具体指令'),'维持领域，不指定目标');
 await click(app,'能力管理');ensure(app.textContent.includes('有未保存的编辑')&&app.textContent.includes('确认发动'),'tab switch dropped launch draft');view.open();ensure(label(app,'具体指令').value==='维持领域，不指定目标','reopen dropped draft');
 await click(app,'确认发动');
 let effects=activeEffects(api.read(),ctx.chat);ensure(effects.length===1&&effects[0].targetMode==='direct'&&effects[0].target==='','no-target activation stored a fake target');
 const firstSnapshot=JSON.stringify(effects[0].skill),promptBefore=compile(api.read(),ctx.chat);
 ensure(!promptBefore.includes('不应写入的旧目标'),'hidden target leaked into prompt');
 await click(app,'管理分组');await click(app,'新建分组');set(label(app,'分组名称'),'空分组');await click(app,'保存分组');
 set(label(app,'能力分组'),'空分组');ensure(label(app,'选择能力').options.length===1,'empty group contains unrelated ability');ensure(![...app.querySelectorAll('button')].some(b=>b.textContent==='发动所选能力'),'group switch silently chose ability');
 await click(app,'管理分组');await click(card(app,'战斗 ·'),'重命名分组');set(label(app,'分组名称'),'火系');await click(app,'保存分组');
 ensure(abilityGroup(api.read().skills[0])==='火系','rename did not move abilities');
 set(label(app,'能力分组'),'火系');set(label(app,'选择能力'),'fire');await click(app,'管理分组');await click(card(app,'火系 ·'),'删除分组');
 ensure(groupNames(api.read()).includes('火系'),'group deleted before confirmation');await click(app,'确认删除分组');
 ensure(api.read().skills.length===3&&abilityGroup(api.read().skills[0])==='未分组','deleting group deleted ability');
 ensure(compile(api.read(),ctx.chat)===promptBefore,'group changes rewrote active snapshot/prompt');
 set(label(app,'能力分组'),'未分组');set(label(app,'选择能力'),'fire');await click(app,'编辑所选能力');
 set(label(app,'所属分组'),'探索');set(label(app,'默认发动方式'),'direct');await click(app,'保存能力');
 ensure(abilityGroup(api.read().skills[0])==='探索'&&api.read().skills[0].ui.targetMode==='direct','editing group/default activation failed');
 ensure(JSON.stringify(activeEffects(api.read(),ctx.chat)[0].skill)===firstSnapshot,'ability edit changed active rule snapshot');
 set(label(app,'能力分组'),'探索');set(label(app,'选择能力'),'fire');await click(app,'编辑所选能力');set(label(app,'技能名称'),'保存失败仍保留的名字');
 failSave=true;await click(app,'保存能力');ensure(label(app,'技能名称').value==='保存失败仍保留的名字','failed save lost editor');ensure(api.read().skills[0].name==='燃烧领域','failed save did not roll back');failSave=false;
 await click(app,'返回');
 const chat=document.createElement('div');chat.id='chat';document.body.append(chat);
 for(let i=0;i<2;i++){const e=document.createElement('div');e.className='mes';e.setAttribute('mesid',i);e.innerHTML='<div class="mes_block"><div class="mes_text">虚构楼层文本</div></div>';chat.append(e);}
 const originalHTML=[...chat.querySelectorAll('.mes_text')].map(n=>n.innerHTML);
 const installer=installExtraFloorButtons('effects'),leases=[];
 if(managed){ensure(participants.length===1,'managed participant missing');ensure(!chat.querySelector('.amin-floor'),'claimed unowned DOM');for(const e of chat.querySelectorAll('.mes'))leases.push(participants[0].didMount({element:e}));}
 const floorButton=i=>chat.querySelector('[mesid="'+i+'"] button[data-floor-app="effects"]');
 const floor=i=>chat.querySelector('[mesid="'+i+'"] .amin-extra-floor-window');
 floorButton(0).click();floorButton(1).click();skin.apply();
 ensure(floor(0).textContent.includes('此入口不是历史楼层快照'),'changed existing floor context semantics');
 set(label(floor(0),'能力分组'),'探索');set(label(floor(0),'选择能力'),'sense');
 set(label(floor(1),'能力分组'),'未分组');set(label(floor(1),'选择能力'),'old');
 ensure(label(floor(0),'选择能力').value==='sense'&&label(floor(1),'选择能力').value==='old','floor choices leaked');
 const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);ensure(new Set(ids).size===ids.length,'duplicate IDs across main/floors');
 set(label(floor(0),'发动方式'),'direct');await click(floor(0),'发动所选能力');await click(floor(0),'确认发动');
 ensure(activeEffects(api.read(),ctx.chat).length===2,'floor direct activation failed');ensure(app.textContent.includes('直接发动'),'main did not reflect floor record');
 set(label(floor(1),'目标角色'),'对象乙');await click(floor(1),'发动所选能力');await click(floor(1),'确认发动');
 ensure(activeEffects(api.read(),ctx.chat).some(e=>e.target==='对象乙'&&e.targetMode==='targeted'),'targeted flow broke');
 ensure(label(floor(0),'选择能力').value==='sense'&&label(floor(1),'选择能力').value==='old','shared save switched ability selection');
 ensure(document.documentElement.scrollWidth<=Math.max(document.documentElement.clientWidth,390),'viewport overflows');
 for(const n of document.querySelectorAll('.amin-reply-floor-body'))ensure(n.scrollWidth<=n.clientWidth+1,'floor body overflows');
 await click(floor(1),'编辑所选能力');set(label(floor(1),'技能名称'),'不应跨聊天保存');
 ctx.chatMetadata={};await click(floor(1),'保存能力');ensure(!api.read().skills.some(s=>s.name==='不应跨聊天保存'),'stale form wrote across metadata change');
 emit('chat');ensure(api.read().events.length===0,'old effects leaked into new chat');ensure(!floor(1).textContent.includes('不应跨聊天保存'),'old editor displayed in new chat');
 ensure(JSON.stringify([...chat.querySelectorAll('.mes_text')].map(n=>n.innerHTML))===JSON.stringify(originalHTML),'message DOM was altered');
 const before=handlers.get('chat').size;await click(floor(0),'收起');ensure(handlers.get('chat').size===before-1,'floor listener not removed');
 if(managed){for(const release of leases)release?.();}else {chat.remove();installer.refresh();}
 view.dispose();ensure(saves>0,'settings were not persisted');ensure(!document.querySelector('.amin-effects'),'disposed effects views remain');
 return {managed,checks:'group migration/CRUD/filtering, direct and targeted activation, draft and rollback guards, snapshots, main+two floors, stale metadata, unique IDs, 390px'};
}
