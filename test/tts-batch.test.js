import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayer} from '../apps/tts/service.js';
import {createLibrary} from '../apps/tts/library.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
test('cloud batch has three in flight, stores successes and retries only failures',async()=>{
 let active=0,peak=0,fail=true;const calls=[],pending=[];const library=createLibrary();const audio={volume:1,pause(){},load(){},removeAttribute(){},play(){throw Error('generate-only must not play');}};
 const player=createPlayer({audio,library,check:async()=>{},request:async(url,init)=>{const text=JSON.parse(init.body).messages[1].content;calls.push(text);active++;peak=Math.max(peak,active);await new Promise(r=>pending.push(r));active--;if(fail&&text==='乙')throw Error('temporary');return Response.json({choices:[{message:{audio:{data:btoa('0'.repeat(60))}}}]});}});
 const cfg={provider:'mimo-direct',voicePrompt:'基础',cloud:{mimoKey:'test'},volume:1,speed:1};const task=player.play(['甲','乙','丙','丁'].map(text=>({text,type:'narration'})),'one',cfg,{generateOnly:true});await tick();assert.equal(active,3);for(let i=0;i<4;i++){pending.shift()?.();await tick();}await task;assert.equal(peak,3);assert.equal((await library.list('one')).length,3);assert.equal(player.snapshot().canRetry,true);fail=false;const retry=player.retry();await tick();pending.shift()();await retry;assert.deepEqual(calls,['甲','乙','丙','丁','乙']);assert.equal((await library.list('one')).length,4);
});
test('stop batch prevents queued requests and late results from being saved',async()=>{
 let calls=0;const pending=[],library=createLibrary();const audio={volume:1,pause(){},load(){},removeAttribute(){}};const player=createPlayer({audio,library,check:async()=>{},request:async()=>{calls++;await new Promise(r=>pending.push(r));return Response.json({choices:[{message:{audio:{data:btoa('0'.repeat(60))}}}]});}});const task=player.play(Array.from({length:8},(_,i)=>({text:String(i),type:'narration'})),'one',{provider:'mimo-direct',voicePrompt:'基础',cloud:{mimoKey:'test'},speed:1,volume:1},{generateOnly:true});await tick();player.stop();for(const r of pending)r();await task;assert.equal(calls,3);assert.equal((await library.list('one')).length,0);
});
