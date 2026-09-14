import {getAppearance} from './settings/appearance.js';
import {effectsDefaults} from './desktop-effects-model.js';
export function installDesktopEffects(home,cards){
 const stage=document.createElement('div');stage.className='amin-tile-stage';cards.before(stage);stage.append(cards);
 const backdrop=document.createElement('div');backdrop.className='amin-desktop-backdrop';backdrop.setAttribute('aria-hidden','true');home.prepend(backdrop);
 const fx=document.createElement('div');fx.className='amin-desktop-fx';fx.setAttribute('aria-hidden','true');stage.append(fx);
 const status=document.createElement('p');status.className='amin-media-status';status.setAttribute('role','status');stage.after(status);
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');let video=null,last='',ticket=0;
 const visible=()=>!document.hidden&&!home.hidden&&!home.closest('.amin-drawer').hidden;
 const fitBackdrop=()=>{if(home.hidden)return;const bottom=Math.max(home.clientHeight,...[...home.children].filter(e=>e!==backdrop).map(e=>e.offsetTop+e.offsetHeight));backdrop.style.height=bottom+'px';};
 const playback=()=>{fitBackdrop();const active=visible()&&!reduced.matches&&!home.classList.contains('amin-tiles-editing');home.classList.toggle('amin-motion-paused',!active);if(video){if(active){const v=video;v.play().catch(()=>{if(video===v&&visible())status.textContent='视频未自动播放，可重新打开主页或检查媒体地址。';});}else video.pause();}};
 function apply(){const d=getAppearance().snapshot().desktop.effects??effectsDefaults();home.dataset.backdrop=d.preset;home.dataset.tileFinish=d.preset==='none'&&d.effect==='none'&&d.tileOpacity===100&&d.border===0&&d.shadow===0?'plain':'layered';backdrop.style.backgroundImage=d.preset==='image'&&d.image?`url(${JSON.stringify(d.image)})`:'';
 home.style.setProperty('--amin-wall-shade',d.shade/100);home.style.setProperty('--amin-tile-alpha',d.tileOpacity+'%');home.style.setProperty('--amin-tile-border',d.border+'px');home.style.setProperty('--amin-tile-shadow',d.shadow+'px');fx.style.opacity=d.effectOpacity/100;
 const sig=JSON.stringify([d.effect,d.amount,d.speed,d.video]);if(sig!==last){last=sig;ticket++;video?.pause();if(video){video.removeAttribute('src');video.load();}video=null;fx.replaceChildren();status.textContent='';
 if(d.effect==='sakura'){for(let i=0;i<d.amount;i++){const p=document.createElement('i');p.className='amin-petal';p.style.left=((i*37.31)%100)+'%';p.style.setProperty('--duration',(d.speed*(.8+(i%5)*.13))+'s');p.style.setProperty('--delay',(-i*d.speed/d.amount)+'s');p.style.setProperty('--drift',((i%2?-1:1)*(20+i%70))+'px');p.style.width=(7+i%7)+'px';fx.append(p);}}
 if(d.effect==='video'&&d.video){const v=document.createElement('video'),run=ticket;video=v;v.muted=true;v.loop=true;v.playsInline=true;v.preload='metadata';v.setAttribute('aria-hidden','true');v.onerror=()=>{if(run===ticket)status.textContent='视频加载失败，请检查地址及浏览器支持的格式。';};v.src=d.video;fx.append(v);}
 }playback();}
 const observer=new MutationObserver(playback);observer.observe(home,{attributes:true,attributeFilter:['hidden','class']});observer.observe(home.closest('.amin-drawer'),{attributes:true,attributeFilter:['hidden']});document.addEventListener('visibilitychange',playback);reduced.addEventListener('change',playback);
 new ResizeObserver(()=>{fitBackdrop();fx.style.setProperty('--fall-height',stage.clientHeight+'px');}).observe(stage);
 getAppearance().subscribe(apply);apply();
}
