import test from 'node:test';
import assert from 'node:assert/strict';
import {launchTarget,waitForService} from '../apps/tts/launcher.js';
const config={provider:'mimo',url:'http://127.0.0.1:9884'};
test('launcher only dispatches fixed local engines and ports',()=>{
 assert.equal(launchTarget(config).uri,'amin-tts://start/mimo');
 for(const c of [{...config,provider:'mimo-direct'},{...config,url:'http://example.com:9884'},{...config,url:'http://localhost:9999'}])assert.throws(()=>launchTarget(c));
});
test('startup detects service without requiring an in-memory MiMo key',async()=>{
 let calls=0;const result=await waitForService(config,{request:async()=>{if(!calls++)throw Error('offline');return Response.json({app:'mimo-rvc-studio',rvc_model:'DXL1.pth',key_configured:false});},pause:async()=>{}});
 assert.equal(calls,2);assert.equal(result.key_configured,false);
});
test('startup rejects port collision, times out and honors cancellation',async()=>{
 await assert.rejects(waitForService(config,{request:async()=>Response.json({app:'other'})}),/占用/);
 await assert.rejects(waitForService(config,{request:async()=>{throw Error('offline');},pause:async()=>{},attempts:2}),/尚未连接/);
 const controller=new AbortController();controller.abort();await assert.rejects(waitForService(config,{signal:controller.signal}),{name:'AbortError'});
});
