// Runs inside the isolated Chromium fixture, including the real shared store and floor installer.
import {harness} from '../test/fixtures.js';
import {mount} from '../view.js';
import {getStore} from '../service.js';
import {installExtraFloorButtons} from '../../extra-floor-ui.js';
import {mountFloorControl} from '../../../settings/floor-layout.js';
import {initializeAppearance,installAppearance} from '../../../settings/appearance.js';
const ensure=(value,message)=>{if(!value)throw Error(message);};
const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('DOM state timed out');};
export async function runFloorBrowserChecks({managed=false}={}){
 const h=harness();window.SillyTavern={getContext:h.current};const listeners=new Map();h.ctx.eventTypes={CHAT_CHANGED:'chat',MESSAGE_DELETED:'deleted',MESSAGE_SWIPED:'swiped'};h.ctx.eventSource={on(k,fn){const a=listeners.get(k)??[];a.push(fn);listeners.set(k,a);},removeListener(k,fn){listeners.set(k,(listeners.get(k)??[]).filter(v=>v!==fn));}};const emit=k=>{for(const fn of listeners.get(k)??[])fn();};
 h.ctx.chat.push({mes:'第二层原文',name:'角色',swipe_id:0},{mes:'系统消息',is_system:true});h.api.dispose();
 const participants=[];if(managed)window.__TAURITAVERN__={api:{chatSurface:{protocolVersion:1,isManagedOwnershipRequired:()=>true,registerParticipant:p=>participants.push(p)}}};
 for(const href of ['/ui.css','/settings/appearance.css'])await new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=reject;document.head.append(link);});
 const appearance=initializeAppearance(h.current),skin=installAppearance(document),app=document.getElementById('app');
 const os=await mount(app),store=await getStore();
 const chat=document.createElement('div');chat.id='chat';chat.style.cssText='width:100%;box-sizing:border-box;padding:8px';document.body.append(chat);
 const messages=h.ctx.chat.map((m,index)=>{const e=document.createElement('div');e.className='mes';e.setAttribute('mesid',String(index));const block=document.createElement('div');block.className='mes_block';const text=document.createElement('div');text.className='mes_text';text.textContent=m.mes;block.append(text);e.append(block);chat.append(e);return e;});
 const originals=messages.map(e=>e.querySelector('.mes_text').innerHTML);
 const fakeHost=document.createElement('div'),fakeButton=document.createElement('button');fakeButton.textContent='状态测试';const status=mountFloorControl(messages[0],'status',fakeHost,fakeButton);fakeButton.onclick=()=>status.setOpen(true);
 const installer=installExtraFloorButtons('organizations'),leases=[];
 if(managed){ensure(participants.length===1&&participants[0].id==='amin-os/organizations-floor','managed participant identity');ensure(!chat.querySelector('button[data-floor-app=organizations]'),'must not claim unmanaged DOM');for(const e of messages)leases.push(participants[0].didMount({element:e}));}
 const button=e=>e.querySelector('.amin-floor-toolbar button[data-floor-app=organizations]');
 const panel=e=>e.querySelector('.amin-extra-floor-window');
 const click=async(root,label)=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===label);ensure(b,'missing button '+label);await b.onclick();};
 ensure(chat.querySelectorAll('button[data-floor-app=organizations]').length===2,'one button per non-system floor');ensure(!button(messages[2]),'system messages excluded');
 ensure([...messages[0].querySelector('.amin-floor-toolbar').children].map(e=>e.dataset.floorApp).join(',')==='status,organizations','fixed order');
 button(messages[1]).click();button(messages[1]).click();await new Promise(r=>setTimeout(r,30));ensure(!panel(messages[1]),'late async mount must not resurrect closed window');
 button(messages[0]).click();await wait(()=>panel(messages[0])?.querySelector('.amin-organizations'));
 ensure(panel(messages[0]).textContent.includes('此入口不是历史楼层快照'),'current-chat notice');ensure(button(messages[0]).getAttribute('aria-expanded')==='true','expanded accessibility state');
 const host=messages[0].querySelector('.amin-extra-floor');status.setOpen(true);ensure(host.style.order==='1'&&fakeHost.style.order==='2','opening order');
 await click(panel(messages[0]),'收起');ensure(!panel(messages[0]),'collapse releases view');button(messages[0]).click();await wait(()=>panel(messages[0])?.querySelector('.amin-organizations'));ensure(host.style.order==='2'&&fakeHost.style.order==='1','reopen follows previous windows');
 button(messages[1]).click();await wait(()=>panel(messages[1])?.querySelector('.amin-organizations'));installer.refresh();installer.refresh();ensure(chat.querySelectorAll('button[data-floor-app=organizations]').length===2,'refresh never duplicates buttons');
 await click(panel(messages[0]),'编辑总览');panel(messages[0]).querySelector('[aria-label="当前局势"]').value='楼层同步修改';await click(panel(messages[0]),'预览保存');ensure(store.read().summary==='','preview is inert');ensure(app.textContent.includes('资料变更预览')&&panel(messages[1]).textContent.includes('资料变更预览'),'all entries share pending preview');await click(panel(messages[0]),'确认应用');ensure(store.read().summary==='楼层同步修改','floor confirm writes current store');ensure(app.textContent.includes('楼层同步修改')&&panel(messages[1]).textContent.includes('楼层同步修改'),'OS and another floor reflect same state');
 let prefs=appearance.snapshot();prefs.floor.overrides.organizations={width:640,desktopHeight:60,mobileHeight:50};prefs.floor.alignment='center';appearance.save(prefs);skin.apply();ensure(host.style.getPropertyValue('--amin-floor-width')==='640px','independent dimensions applied');ensure(host.dataset.aminSurface==='organizations','application appearance scope');ensure(messages[0].querySelector('.amin-floor').dataset.alignment==='center','unified alignment');
 const bounds=panel(messages[0]).getBoundingClientRect();ensure(bounds.width<=innerWidth,'floor exceeds mobile viewport');
 prefs=appearance.snapshot();prefs.floor.buttons.organizations=false;appearance.save(prefs);ensure(!panel(messages[0])&&!panel(messages[1]),'hide closes all organization windows');ensure(button(messages[0]).hidden&&button(messages[1]).hidden,'hide applies to all buttons');ensure(!fakeButton.hidden,'other applications unaffected');prefs.floor.buttons.organizations=true;appearance.save(prefs);ensure(!button(messages[0]).hidden,'show restores buttons');
 button(messages[1]).click();await wait(()=>panel(messages[1])?.querySelector('.amin-organizations'));h.ctx.chat.splice(1,1);if(managed)leases[1]();messages[1].remove();messages[2].setAttribute('mesid','1');emit('deleted');installer.refresh();ensure(!messages[1].querySelector('.amin-extra-floor-window'),'deletion releases window');
 button(messages[0]).click();await wait(()=>panel(messages[0])?.querySelector('.amin-organizations'));h.switchChat();emit('chat');installer.refresh();ensure(!panel(messages[0]),'chat change removes old panel');ensure(chat.querySelectorAll('button[data-floor-app=organizations]').length===1,'chat refresh has no stale controls');
 button(messages[0]).click();await wait(()=>panel(messages[0])?.querySelector('.amin-organizations'));h.current().chat[0].swipe_id=1;emit('swiped');installer.refresh();ensure(messages[0].querySelectorAll('button[data-floor-app=organizations]').length===1,'swipe keeps one current-chat entry');
 if(managed){leases[0]();ensure(!button(messages[0])&&!panel(messages[0]),'managed lease disposal');leases[0]=participants[0].didMount({element:messages[0]});ensure(!!button(messages[0]),'managed remount');}
 ensure(messages.every((e,i)=>e.querySelector('.mes_text').innerHTML===originals[i]),'message body must remain unchanged');
 for(const lease of leases)lease?.();chat.remove();installer.refresh();status.dispose();os.dispose();store.dispose();
 return managed?'managed floor lifecycle passed':'standard floor lifecycle passed';
}
