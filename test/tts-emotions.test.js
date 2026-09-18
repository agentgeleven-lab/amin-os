import test from 'node:test';
import assert from 'node:assert/strict';
import {EMOTIONS,localEmotion,speedMax} from '../apps/tts/emotions.js';
import {saveSettings,createPlayer} from '../apps/tts/service.js';
test('new emotions and free descriptions reach old DXL1 via its supported prompt',()=>{
 assert.equal(EMOTIONS.length,18);
 assert.deepEqual(localEmotion('基础','温柔'),{prompt:'基础',emotion:'温柔'});
 const custom=localEmotion('基础','语气急切，像赶时间');assert.match(custom.prompt,/语气急切，像赶时间/);assert.equal(custom.emotion,'日常');
 assert.match(localEmotion('基础','害羞').prompt,/略带迟疑/);
});
test('MiMo stores 2x and custom emotion, other engines retain their speed limits',()=>{
 const original=globalThis.SillyTavern,ctx={extensionSettings:{},saveSettingsDebounced(){}};globalThis.SillyTavern={getContext:()=>ctx};
 const config={url:'http://localhost:9884',seed:42,range:'all',quotes:'“”',speed:2,volume:1,profiles:{dialogue:{emotion:'紧张但不尖叫'}}};
 try{for(const provider of ['mimo','mimo-direct']){saveSettings({...config,provider});assert.equal(ctx.extensionSettings.aminTTS.profiles.dialogue.speed,2);assert.equal(ctx.extensionSettings.aminTTS.profiles.dialogue.emotion,'紧张但不尖叫');}assert.throws(()=>saveSettings({...config,provider:'azuma'}),/1.3/);assert.throws(()=>saveSettings({...config,provider:'mimo',speed:2.1}),/0.7/);assert.equal(speedMax('volcengine'),1.3);}finally{globalThis.SillyTavern=original;}
});
test('MiMo 2x changes playback rate while preserving pitch and source text',async()=>{
 const audio={volume:1,pause(){},load(){},removeAttribute(){},async play(){queueMicrotask(()=>this.onended?.());}};
 const player=createPlayer({audio,check:async()=>{},request:async(url,init)=>{assert.equal(JSON.parse(init.body).messages[1].content,'原文');return Response.json({choices:[{message:{audio:{data:btoa('0'.repeat(60))}}}]});},urls:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}}});
 await player.play('原文','app',{provider:'mimo-direct',speed:2,volume:1,voicePrompt:'基础',cloud:{mimoKey:'test'}});assert.equal(audio.playbackRate,2);assert.equal(audio.preservesPitch,true);assert.equal(player.snapshot().message,'朗读完成');
});
