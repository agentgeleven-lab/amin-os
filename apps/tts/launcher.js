import {endpoint} from './model.js';
import {delay} from './dialogue.js';
const engines={azuma:{port:9883,app:'azuma-bert-vits2'},mimo:{port:9884,app:'mimo-rvc-studio'}};
export function launchTarget(config){
 const engine=engines[config.provider];if(!engine)throw Error('云端引擎无需启动本地服务');
 const url=new URL(endpoint(config.url));
 if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.port!==String(engine.port))throw Error('启动器使用固定本机端口 '+engine.port+'，请先恢复本机服务地址');
 return {...engine,base:url.origin,uri:'amin-tts://start/'+config.provider};
}
export async function waitForService(config,{signal,request=fetch,pause=delay,attempts=90}={}){
 const target=launchTarget(config);
 for(let i=0;i<attempts;i++){
  signal?.throwIfAborted();let h;
  try{const response=await request(target.base+'/health',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(1200)]):AbortSignal.timeout(1200),cache:'no-store'});if(response.ok)h=await response.json();}catch{signal?.throwIfAborted();}
  if(h){if(h.app!==target.app)throw Error('端口被其他服务占用，请检查本机服务');if(config.provider==='mimo'&&h.rvc_model!=='DXL1.pth')throw Error('服务未配置 DXL1');if(config.provider==='mimo'||h.ready)return h;}
  await pause(1000,signal);
 }
 throw Error('尚未连接。请确认已安装 Amin 语音启动器，并允许系统打开；也可用原来的启动试听.cmd。');
}
