import {createTileDesktop} from './tile-desktop.js';
import {createBrandMark,createCollapseMark} from './brand.js';
import {getAppearance} from './settings/appearance.js';
import { clampPosition, drawerPlacement } from './window-state.js';

const APPS=[
    {id:'map',name:'地图',sub:'记录地点，探索你的世界',icon:'⌘',color:'mint'},
    {id:'status',name:'世界状态',sub:'角色、关系与剧情的此刻',icon:'◈',color:'lavender'},
    {id:'reply',name:'回复选项',sub:'拟写下一句，由你决定',icon:'≋',color:'peach'},
    {id:'ai',name:'AI 设置',sub:'共享 API、异步预设与任务',icon:'✧',color:'mint'},
    {id:'settings',name:'设置',sub:'全局外观与应用个性化',icon:'⚙',color:'lavender'},
];
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};

function icon(id){
    const paths={map:'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2V5z M9 3v16 M15 5v16',status:'M4 5h16v14H4z M8 9h3 M8 13h8 M15 9h1',reply:'M4 4h16v12H9l-5 4V4z M8 8h8 M8 12h5',ai:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8'};
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
    if(id==='settings')paths.settings='M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6';
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',paths[id]);svg.append(path);return svg;
}
const STORE='amin-os.window.v1';
export function createShell(){
    const root=el('div');root.id='amin-os';
    const launcher=el('button','amin-launcher');launcher.type='button';launcher.title='点击打开 Amin os · 拖动移动';launcher.setAttribute('aria-label','打开 Amin os');launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-controls','amin-drawer');
    const launcherMark=el('span','amin-mark');launcherMark.append(createBrandMark(document,{compact:true}));launcher.append(launcherMark,el('span','amin-launcher-name','Amin os'));
    const drawer=el('section','amin-drawer');drawer.id='amin-drawer';drawer.setAttribute('aria-label','Amin os 应用侧栏');drawer.hidden=true;
    const head=el('header','amin-head'),brand=el('div','amin-brand');const brandCopy=el('div');brandCopy.append(el('div','amin-wordmark','Amin os'));const brandMark=el('span','amin-brand-icon');brandMark.append(createBrandMark());brand.append(brandMark,brandCopy);
    const collapse=el('button','amin-icon-button');collapse.append(createCollapseMark());collapse.type='button';collapse.title='收起';collapse.setAttribute('aria-label','收起 Amin os');head.append(brand,collapse);
    const nav=el('nav','amin-app-nav');nav.setAttribute('aria-label','应用导航');
    const homeButton=el('button','amin-home-tab','←');homeButton.type='button';homeButton.title='返回开始屏';homeButton.setAttribute('aria-label','Amin os 首页');nav.append(homeButton);const appHeading=el('span','amin-current-app');nav.append(appHeading);
    const area=el('div','amin-area'),home=el('div','amin-home');
    const cards=el('div','amin-home-apps');home.append(cards);
    const panes={},tabs={},handlers={};let tileDesktop;let active='home',opened=false,epoch=0,blocked='',drag=null,suppressClick=false;
    for(const app of APPS){
        const tab=el('button','amin-app-tab',app.name);tab.type='button';tab.dataset.app=app.id;tab.addEventListener('click',()=>showApp(app.id));tabs[app.id]=tab;nav.append(tab);
        const card=el('button',`amin-app-card amin-${app.color}`);card.type='button';card.dataset.tile=app.id;card.setAttribute('aria-label',`打开${app.name}`);
        const copy=el('span','amin-card-copy');copy.append(el('strong',null,app.name));card.title=app.sub;const appIcon=el('span','amin-app-icon');appIcon.append(icon(app.id));card.append(appIcon,copy,el('span','amin-card-arrow','↗'));cards.append(card);
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
        const options=getAppearance()?.snapshot().window;
        let rect=drawerPlacement(position,width,height,options);
        Object.assign(drawer.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
        if(opened&&active==='home'){
            const contentHeight=Math.ceil(head.getBoundingClientRect().height+nav.getBoundingClientRect().height+home.scrollHeight+4);
            rect=drawerPlacement(position,width,height,{...options,height:Math.min(rect.height,contentHeight)});
            Object.assign(drawer.style,{top:rect.y+'px',height:rect.height+'px'});
        }
    }
    function save(){try{localStorage.setItem(STORE,JSON.stringify(position));}catch{}}
    function open(){opened=true;drawer.hidden=false;launcher.setAttribute('aria-expanded','true');launcher.setAttribute('aria-label','收起 Amin os');place();}
    function close(){tileDesktop?.leave();opened=false;drawer.hidden=true;launcher.setAttribute('aria-expanded','false');launcher.setAttribute('aria-label','打开 Amin os');launcher.focus();}
    function select(id){active=id;nav.hidden=id==='home';appHeading.textContent=APPS.find(a=>a.id===id)?.name??'';home.hidden=id!=='home';for(const [key,pane]of Object.entries(panes)){pane.hidden=key!==id;tabs[key].setAttribute('aria-current',key===id?'page':'false');}homeButton.setAttribute('aria-current',id==='home'?'page':'false');notice.hidden=true;}
    function showHome(){epoch++;select('home');open();if(blocked){message.textContent=blocked;retry.hidden=true;notice.hidden=false;}}
    async function showApp(id){
        if(!panes[id])return;
        if(blocked){showHome();return;}
        tileDesktop?.leave();select(id);open();const ticket=++epoch;message.textContent='正在打开…';retry.hidden=true;notice.hidden=false;
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
    getAppearance()?.subscribe(place);
    window.addEventListener('resize',place);window.visualViewport?.addEventListener('resize',place);place();select('home');
    tileDesktop=createTileDesktop({home,cards,apps:APPS,openApp:showApp,onLayout:place});
    return {panes,open:resume,close,home:showHome,showApp,register(id,fn){handlers[id]=fn;},refreshActive(){if(opened&&active!=='home')showApp(active);},setBlocked(text){blocked=text;cards.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent=text;retry.hidden=true;notice.hidden=false;}};
}
