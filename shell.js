import { clampPosition, drawerPlacement } from './window-state.js';

const APPS=[
    {id:'ai',name:'AI 设置',sub:'共享 API、异步预设与任务',icon:'✧',color:'mint'},
    {id:'map',name:'地图',sub:'记录地点，探索你的世界',icon:'⌘',color:'mint'},
    {id:'status',name:'世界状态',sub:'角色、关系与剧情的此刻',icon:'◈',color:'lavender'},
    {id:'reply',name:'回复选项',sub:'为下一句话，找一点灵感',icon:'≋',color:'peach'},
];
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
const STORE='amin-os.window.v1';
export function createShell(){
    const root=el('div');root.id='amin-os';
    const launcher=el('button','amin-launcher');launcher.type='button';launcher.title='点击打开 Amin os · 拖动移动';launcher.setAttribute('aria-label','打开 Amin os');launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-controls','amin-drawer');
    launcher.append(el('span','amin-mark','a'),el('span','amin-launcher-name','Amin os'),el('span','amin-launcher-dot'));
    const drawer=el('section','amin-drawer');drawer.id='amin-drawer';drawer.setAttribute('aria-label','Amin os 应用侧栏');drawer.hidden=true;
    const head=el('header','amin-head'),brand=el('div','amin-brand');brand.append(el('span','amin-brand-icon','a'),el('div',null,'Amin os'));
    const collapse=el('button','amin-icon-button','⌄');collapse.type='button';collapse.title='收起';collapse.setAttribute('aria-label','收起 Amin os');head.append(brand,collapse);
    const nav=el('nav','amin-app-nav');nav.setAttribute('aria-label','应用导航');
    const homeButton=el('button','amin-home-tab','⌂');homeButton.type='button';homeButton.title='首页';homeButton.setAttribute('aria-label','Amin os 首页');nav.append(homeButton);
    const area=el('div','amin-area'),home=el('div','amin-home');
    const intro=el('div','amin-intro');intro.append(el('span','amin-eyebrow','YOUR LITTLE WORLD'),el('h2',null,'故事，随手展开。'),el('p',null,'一张地图，一眼此刻，一句新的可能。'));home.append(intro);
    const cards=el('div','amin-home-apps');home.append(cards);
    const foot=el('div','amin-home-note');foot.append(el('span',null,'✧'),el('span',null,'留在故事里，其他的交给这里。'));home.append(foot);
    const panes={},tabs={},handlers={};let active='home',opened=false,epoch=0,blocked='',drag=null,suppressClick=false;
    for(const app of APPS){
        const tab=el('button','amin-app-tab',app.name);tab.type='button';tab.dataset.app=app.id;tab.addEventListener('click',()=>showApp(app.id));tabs[app.id]=tab;nav.append(tab);
        const card=el('button',`amin-app-card amin-${app.color}`);card.type='button';card.setAttribute('aria-label',`打开${app.name}`);
        const copy=el('span','amin-card-copy');copy.append(el('strong',null,app.name),el('span',null,app.sub));card.append(el('span','amin-app-icon',app.icon),copy,el('span','amin-card-arrow','↗'));card.addEventListener('click',()=>showApp(app.id));cards.append(card);
        const pane=el('section','amin-app-pane');pane.dataset.app=app.id;pane.hidden=true;pane.setAttribute('aria-label',app.name);panes[app.id]=pane;
    }
    const notice=el('div','amin-notice');notice.hidden=true;notice.setAttribute('role','status');
    const message=el('p'),retry=el('button','amin-retry','重试');retry.type='button';retry.addEventListener('click',()=>showApp(active));notice.append(message,retry);
    area.append(home,...Object.values(panes),notice);drawer.append(head,nav,area);
    root.append(drawer,launcher);document.body.append(root);
    let saved;try{saved=JSON.parse(localStorage.getItem(STORE));}catch{}
    const viewport=()=>({width:document.documentElement.clientWidth||innerWidth,height:window.visualViewport?.height||innerHeight});
    const initial=viewport();
    let position=clampPosition(saved??{x:initial.width-142,y:initial.height-78},initial.width,initial.height);
    function place(){
        const {width,height}=viewport();
        position=clampPosition(position,width,height);launcher.style.left=position.x+'px';launcher.style.top=position.y+'px';
        const rect=drawerPlacement(position,width,height);
        Object.assign(drawer.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
    }
    function save(){try{localStorage.setItem(STORE,JSON.stringify(position));}catch{}}
    function open(){opened=true;drawer.hidden=false;launcher.setAttribute('aria-expanded','true');launcher.setAttribute('aria-label','收起 Amin os');place();}
    function close(){opened=false;drawer.hidden=true;launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-label','打开 Amin os');launcher.focus();}
    function select(id){active=id;home.hidden=id!=='home';for(const [key,pane]of Object.entries(panes)){pane.hidden=key!==id;tabs[key].setAttribute('aria-current',key===id?'page':'false');}homeButton.setAttribute('aria-current',id==='home'?'page':'false');notice.hidden=true;}
    function showHome(){epoch++;select('home');open();if(blocked){message.textContent=blocked;retry.hidden=true;notice.hidden=false;}}
    async function showApp(id){
        if(!panes[id])return;
        if(blocked){showHome();return;}
        select(id);open();const ticket=++epoch;message.textContent='正在打开…';retry.hidden=true;notice.hidden=false;
        try{if(!handlers[id])throw Error('应用仍在加载，请稍后重试。');await handlers[id]();if(ticket===epoch)notice.hidden=true;}
        catch(error){if(ticket===epoch){message.textContent=error.message||'打开失败，请重试。';retry.hidden=false;notice.hidden=false;}}
    }
    const resume=()=>active==='home'?open():showApp(active);
    launcher.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;}if(opened)close();else resume();});
    collapse.addEventListener('click',close);homeButton.addEventListener('click',showHome);
    drawer.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close();}});
    launcher.addEventListener('keydown',e=>{const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(moves[e.key]){e.preventDefault();position.x+=moves[e.key][0]*10;position.y+=moves[e.key][1]*10;place();save();}});
    launcher.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0)return;suppressClick=false;drag={id:e.pointerId,x:e.clientX,y:e.clientY,start:{...position},moved:false};launcher.setPointerCapture(e.pointerId);});
    launcher.addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>5)drag.moved=true;if(drag.moved){position={x:drag.start.x+dx,y:drag.start.y+dy};place();}});
    const stop=e=>{if(drag?.id!==e.pointerId)return;suppressClick=drag.moved;drag=null;save();};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])launcher.addEventListener(name,stop);
    window.addEventListener('resize',place);window.visualViewport?.addEventListener('resize',place);place();select('home');
    return {panes,open:resume,close,home:showHome,showApp,register(id,fn){handlers[id]=fn;},refreshActive(){if(opened&&active!=='home')showApp(active);},setBlocked(text){blocked=text;cards.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent=text;retry.hidden=true;notice.hidden=false;}};
}
