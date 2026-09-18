import {endpoint} from './model.js';
import {DEFAULT_QUOTES,quotePairs,profiles,planSpeech,delay} from './dialogue.js';
const context=()=>globalThis.SillyTavern?.getContext?.();
export function settings(){return {url:'http://127.0.0.1:9883',speed:1,volume:1,seed:42,range:'all',quotes:DEFAULT_QUOTES,...context()?.extensionSettings?.aminTTS};}
export function saveSettings(value){
 const url=endpoint(value.url),seed=Number(value.seed),p=profiles(value);
 if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw Error('种子须为 0～4294967295 的整数');
 if(!['all','dialogue','narration'].includes(value.range))throw Error('朗读范围无效');quotePairs(value.quotes);
 for(const [type,v]of Object.entries(p)){const name=type==='dialogue'?'对话':'旁白';if(!Number.isFinite(v.speed)||v.speed<.7||v.speed>1.3)throw Error(name+'语速须为 0.7～1.3');if(!Number.isFinite(v.volume)||v.volume<0||v.volume>1)throw Error(name+'音量须为 0～100%');if(!Number.isInteger(v.pauseMs)||v.pauseMs<0||v.pauseMs>5000)throw Error(name+'停顿须为 0～5000 毫秒');}
 const ctx=context();ctx.extensionSettings.aminTTS={url,seed,speed:p.narration.speed,volume:p.narration.volume,range:value.range,quotes:value.quotes,profiles:p};ctx.saveSettingsDebounced?.();
}
export async function health(config=settings(),signal){const r=await fetch(endpoint(config.url)+'/health',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});if(!r.ok)throw Error('语音服务连接失败：HTTP '+r.status);const h=await r.json();if(h.app!=='azuma-bert-vits2'||!h.ready||h.version!=='2.3'||h.weights!=='G_18200.pth')throw Error('服务不是已选的 Azuma Bert-VITS2 2.3 / G_18200');return h;}
export function createPlayer({audio=new Audio(),request=fetch,check=health,urls=URL}={}){
 let epoch=0,controller=null,objectURL=null,finish=null;const listeners=new Set();let state={phase:'idle',message:'准备就绪',source:null};
 const emit=(patch)=>{state={...state,...patch};for(const f of listeners)f({...state});};
 function clear(){audio.pause();audio.removeAttribute('src');audio.load();if(objectURL)urls.revokeObjectURL(objectURL);objectURL=null;finish?.();finish=null;}
 function stop(message='已停止'){epoch++;controller?.abort();controller=null;clear();emit({phase:'idle',message});}
 async function play(text,source='app',config=settings()){
  stop();const parts=planSpeech(text,config);if(!parts.length){emit({phase:'error',message:'本层没有可朗读的正文',source});return;}const ticket=epoch;controller=new AbortController();const signal=controller.signal;
  const alive=()=>ticket===epoch&&!signal.aborted;
  try{emit({phase:'loading',message:'正在连接东雪莲服务…',source});await check(config,signal);if(!alive())return;
   for(let i=0;i<parts.length;i++){
    emit({phase:'loading',message:`正在合成 ${i+1}/${parts.length} 段…`,source});
    const response=await request(endpoint(config.url)+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:parts[i].text,speed:parts[i].speed,seed:config.seed}),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});
    if(!response.ok)throw Error('合成失败：HTTP '+response.status);const blob=await response.blob();if(!alive())return;if(!blob.type.includes('audio/')||blob.size<44)throw Error('服务未返回有效音频');
    clear();objectURL=urls.createObjectURL(blob);audio.src=objectURL;audio.volume=parts[i].volume;
    await new Promise((resolve,reject)=>{finish=()=>{audio.onended=null;audio.onerror=null;resolve();};audio.onended=()=>finish?.();audio.onerror=()=>{finish=null;reject(Error('音频播放失败'));};emit({phase:'playing',message:`播放 ${i+1}/${parts.length} 段`,source});audio.play().catch(error=>{if(!alive())return;if(error.name==='NotAllowedError')emit({phase:'paused',message:'音频已就绪，请点击继续播放',source});else reject(error);});});
    if(!alive())return;
    if(i<parts.length-1&&parts[i].pauseMs>0){emit({phase:'waiting',message:'段后停顿…',source});await delay(parts[i].pauseMs,signal);if(!alive())return;}
   }clear();emit({phase:'idle',message:'朗读完成',source});
  }catch(error){if(!alive())return;clear();emit({phase:'error',message:error.name==='TimeoutError'?'合成超时，请检查本地服务':error.message+'（请确认本地语音服务已启动）',source});}
 }
 return {play,stop,subscribe(fn){listeners.add(fn);fn({...state});return ()=>listeners.delete(fn);},snapshot:()=>({...state}),setVolume(v){audio.volume=v;},pause(){if(state.phase==='playing'){audio.pause();emit({phase:'paused',message:'已暂停'});}},async resume(){if(state.phase==='paused'){try{await audio.play();emit({phase:'playing',message:'继续播放'});}catch(error){emit({message:error.message});}}}};
}
let player;
export function getPlayer(){if(!player){player=createPlayer();const ctx=context(),ev=ctx?.eventTypes??ctx?.event_types??{};for(const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])if(ev[name])ctx.eventSource?.on(ev[name],()=>player.stop('聊天或消息已变化，朗读停止'));}return player;}

// Each floor can control only the playback it started. Starting another source replaces it.
export function scopedPlayer(player,source){
 const owns=()=>player.snapshot().source===source;
 return {
  play:(text,config)=>player.play(text,source,config),
  pause:()=>{if(owns())player.pause();},
  resume:()=>{if(owns())return player.resume();},
  stop:()=>{if(owns())player.stop();},
  subscribe(fn){return player.subscribe(state=>fn(state.source===source?state:{phase:'idle',message:'准备就绪',source}));},
 };
}
