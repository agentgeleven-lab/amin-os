import {localEmotion} from './emotions.js';
import {endpoint} from './model.js';
import {delay} from './dialogue.js';
export async function mimoHealth(config,signal){const r=await fetch(endpoint(config.url)+'/health',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});if(!r.ok)throw Error('MiMo 服务连接失败');const h=await r.json();if(h.app!=='mimo-rvc-studio'||h.rvc_model!=='DXL1.pth')throw Error('服务尚未切换到 DXL1');if(!h.key_configured)throw Error('请在本地 9884 试听页填写 MiMo 密钥');return h;}
export async function generateMimo(part,config,signal){
 const base=endpoint(config.url);const session=await fetch(base+'/api/session',{signal}).then(r=>{if(!r.ok)throw Error('本地会话失败');return r.json();});
 const direction=localEmotion(config.voicePrompt?.trim()||session.base_prompt,part.emotion??'日常');if(direction.prompt.length>2000)throw Error('基础声线与情绪描述合计过长，请缩短至 2000 字符以内');
 const headers={'Content-Type':'application/json','X-Local-Token':session.token};let id;
 const cancel=()=>{if(id)fetch(base+'/api/jobs/'+id+'/cancel',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(5000)}).catch(()=>{});};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  signal.throwIfAborted();
  // Finish obtaining the job ID even if stopped meanwhile, so the server job can be cancelled.
  const r=await fetch(base+'/api/generate',{method:'POST',headers,body:JSON.stringify({text:part.text,...direction,pitch:0,rvc:true,ratio:config.ratio??.5}),signal:AbortSignal.timeout(15000)});
  const data=await r.json();if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:'MiMo 任务提交失败');id=data.id;if(signal.aborted){cancel();signal.throwIfAborted();}
  const deadline=Date.now()+360000;
  while(Date.now()<deadline){
   signal.throwIfAborted();const jr=await fetch(base+'/api/jobs/'+id,{signal});if(!jr.ok)throw Error('读取语音任务失败');const job=await jr.json();
   if(job.state==='error'||job.state==='cancelled')throw Error(job.status);
   if(job.state==='done'){const result=job.results.find(x=>x.model==='DXL1.pth'&&x.ratio===(config.ratio??.5));if(!result)throw Error('生成结果不是所选 DXL1 音频');const audioURL=new URL(result.url,base);if(audioURL.origin!==base)throw Error('无效音频来源');const response=await fetch(audioURL,{signal});if(!response.ok)throw Error('下载 DXL1 音频失败');return response;}
   await delay(600,signal);
  }cancel();throw Error('MiMo / DXL1 生成超时');
 }finally{signal.removeEventListener('abort',cancel);}
}
