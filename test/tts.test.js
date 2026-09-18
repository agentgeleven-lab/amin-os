import test from 'node:test';
import assert from 'node:assert/strict';
import {chunks,endpoint,plainText} from '../apps/tts/model.js';
import {createPlayer} from '../apps/tts/service.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
const config={url:'http://127.0.0.1:9883',speed:1,volume:1,seed:42};
function rig(request){const audio={src:'',volume:1,pause(){},load(){},removeAttribute(){this.src='';},async play(){this.plays=(this.plays??0)+1;}};let serial=0;const revoked=[];const player=createPlayer({audio,request,check:async()=>{},urls:{createObjectURL:()=>`blob:${++serial}`,revokeObjectURL:x=>revoked.push(x)}});return {player,audio,revoked};}
const response=()=>({ok:true,blob:async()=>new Blob(['0'.repeat(60)],{type:'audio/wav'})});
test('TTS chunks preserve text and surrogate pairs',()=>{const text='测试一段文字。'.repeat(100)+'🌸'.repeat(150),parts=chunks(text);assert.equal(parts.join(''),text);assert.ok(parts.every(x=>x.length<=220&&!/[\uD800-\uDBFF]$/.test(x)));});
test('TTS accepts local endpoints and removes hidden text',()=>{assert.equal(endpoint('http://localhost:9883/'),'http://localhost:9883');assert.throws(()=>endpoint('https://example.com'));assert.throws(()=>endpoint('http://user:pass@localhost'));assert.equal(plainText('<think>secret</think>你好。```hidden```'),'你好。');});
test('stop discards late audio',async()=>{let release;const {player,audio}=rig(()=>new Promise(r=>release=r));const pending=player.play('正文','floor',config);await tick();player.stop();release(response());await pending;assert.equal(audio.plays,undefined);assert.equal(player.snapshot().phase,'idle');});
test('sequential playback preserves voice parameters and releases blobs',async()=>{const requests=[];const {player,audio,revoked}=rig(async(url,init)=>{requests.push(JSON.parse(init.body));return response();});const pending=player.play('测试。'.repeat(100),'floor',config);await tick();assert.equal(requests.length,1);assert.equal(audio.plays,1);player.pause();assert.equal(player.snapshot().phase,'paused');await player.resume();audio.onended();await tick();assert.equal(requests.length,2);audio.onended();await pending;assert.equal(player.snapshot().message,'朗读完成');assert.equal(revoked.length,2);assert.ok(requests.every(x=>x.speed===1&&x.seed===42));});
test('new playback replaces old pending request',async()=>{let release;let count=0;const {player,audio}=rig(()=>++count===1?new Promise(r=>release=r):Promise.resolve(response()));const old=player.play('旧消息','old',config);await tick();const next=player.play('新消息','new',config);await tick();release(response());await old;assert.equal(player.snapshot().source,'new');assert.equal(audio.plays,1);player.stop();await next;});
import {scopedPlayer} from '../apps/tts/service.js';
test('floor controls and progress never operate on another floor',()=>{
 let state={source:'floor-1',phase:'playing',message:'播放 1/2 段'},calls=[],notify;
 const shared={snapshot:()=>state,subscribe(fn){notify=fn;fn(state);return ()=>{};},play:(text,source)=>calls.push(['play',text,source]),pause:()=>calls.push('pause'),resume:()=>calls.push('resume'),stop:()=>calls.push('stop')};
 const first=scopedPlayer(shared,'floor-1'),second=scopedPlayer(shared,'floor-2');let visible;
 second.subscribe(s=>visible=s);assert.equal(visible.phase,'idle');second.pause();second.resume();second.stop();assert.deepEqual(calls,[]);
 first.pause();assert.deepEqual(calls,['pause']);second.play('仅第二层正文');assert.deepEqual(calls.at(-1),['play','仅第二层正文','floor-2']);
 state={source:'floor-2',phase:'playing',message:'播放 1/1 段'};notify(state);assert.equal(visible.message,'播放 1/1 段');first.stop();assert.equal(calls.length,2);second.stop();assert.equal(calls.at(-1),'stop');
});
import {classify,planSpeech,quotePairs,delay} from '../apps/tts/dialogue.js';
test('dialogue classification preserves order, nested quotes and unmatched text',()=>{
 const text='她说：“你好，『朋友』。”随后离开。';const parts=classify(text);assert.deepEqual(parts.map(p=>p.type),['narration','dialogue','narration']);assert.equal(parts.map(p=>p.text).join(''),text);assert.deepEqual(classify('他说：“没说完'),[{type:'narration',text:'他说：“没说完'}]);assert.throws(()=>quotePairs('一行太多字'));assert.equal(classify('甲【乙】丙','【】')[1].type,'dialogue');
});
test('speech plan filters and applies independent parameters without reordering',()=>{
 const c={...config,range:'all',profiles:{dialogue:{speed:1.2,volume:.5,pauseMs:200},narration:{speed:.8,volume:.8,pauseMs:100}}};const text='她说：“你好。”随后离开。';const plan=planSpeech(text,c);assert.deepEqual(plan.map(p=>p.speed),[.8,1.2,.8]);assert.deepEqual(plan.map(p=>p.volume),[.8,.5,.8]);assert.equal(planSpeech(text,{...c,range:'dialogue'}).length,1);assert.equal(planSpeech(text,{...c,range:'narration'}).length,2);assert.equal(planSpeech([{type:'dialogue',text:'手动纠正'}],{...c,range:'dialogue'})[0].speed,1.2);
});
test('typed playback sends different speeds and volumes in original sequence',async()=>{
 const requests=[];const {player,audio}=rig(async(url,init)=>{requests.push(JSON.parse(init.body));return response();});const c={...config,profiles:{dialogue:{speed:1.2,volume:.4,pauseMs:0},narration:{speed:.8,volume:.9,pauseMs:0}}};const done=player.play('旁白。“对话。”','floor',c);await tick();assert.equal(requests[0].speed,.8);assert.equal(audio.volume,.9);audio.onended();await tick();assert.equal(requests[1].speed,1.2);assert.equal(audio.volume,.4);audio.onended();await done;
});
test('stop during paragraph pause prevents the next synthesis',async()=>{
 let count=0;const {player,audio}=rig(async()=>{count++;return response();});const done=player.play('旁白。“对话。”','floor',{...config,profiles:{narration:{pauseMs:5000}}});await tick();audio.onended();await tick();assert.equal(player.snapshot().phase,'waiting');player.stop();await done;assert.equal(count,1);
});
