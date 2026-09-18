import test from 'node:test';
import assert from 'node:assert/strict';
import {generateMimo,mimoHealth} from '../apps/tts/mimo.js';
const config={url:'http://127.0.0.1:9884',ratio:.75,voicePrompt:'基础声线'};
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
test('MiMo client requests selected DXL1 ratio and preserves exact text',async()=>{
 const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,init={})=>{calls.push([String(url),init]);if(String(url).endsWith('/api/session'))return json({token:'local',base_prompt:'默认'});if(String(url).endsWith('/api/generate'))return json({id:'job'});if(String(url).endsWith('/api/jobs/job'))return json({state:'done',results:[{model:'DXL1.pth',ratio:.75,url:'/audio/job/rvc-075.wav'}]});return new Response(new Blob(['audio'],{type:'audio/wav'}));};
 try{await generateMimo({text:'原文：“你好。”',emotion:'温柔'},config,new AbortController().signal);const payload=JSON.parse(calls[1][1].body);assert.deepEqual(payload,{text:'原文：“你好。”',prompt:'基础声线',emotion:'温柔',pitch:0,rvc:true,ratio:.75});assert.ok(calls.at(-1)[0].endsWith('/rvc-075.wav'));assert.ok(calls.every(([url])=>url.startsWith(config.url)));}finally{globalThis.fetch=original;}
});
test('MiMo submission cancelled before job id arrives cancels server job afterwards',async()=>{
 const original=globalThis.fetch,calls=[],controller=new AbortController();let release;
 globalThis.fetch=async(url)=>{calls.push(String(url));if(String(url).endsWith('/api/session'))return json({token:'local',base_prompt:'默认'});if(String(url).endsWith('/api/generate'))return new Promise(r=>release=r);return json({cancelled:true});};
 try{const task=generateMimo({text:'测试'},config,controller.signal);await new Promise(r=>setTimeout(r,0));controller.abort();release(json({id:'job'}));await assert.rejects(task);assert.ok(calls.some(x=>x.endsWith('/api/jobs/job/cancel')));assert.ok(!calls.some(x=>x.includes('/audio/')));}finally{globalThis.fetch=original;}
});
test('MiMo refuses a service still configured for old RVC model',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>json({app:'mimo-rvc-studio',rvc_model:'seren2.pth',key_configured:true});try{await assert.rejects(()=>mimoHealth(config),/DXL1/);}finally{globalThis.fetch=original;}});
