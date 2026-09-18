// One Web Audio source per shared player, initialized from the playback gesture.
export function createVolumeControl(audio,Context=globalThis.AudioContext??globalThis.webkitAudioContext){
 let context,gain;
 return {prepare(volume){if(Context){if(!context){context=new Context();const source=context.createMediaElementSource(audio);gain=context.createGain();source.connect(gain);gain.connect(context.destination);}audio.volume=1;gain.gain.value=volume;context.resume().catch(()=>{});}else{if(volume>1)throw Error('当前环境不支持超过 100% 的音量');audio.volume=volume;}},set(volume){if(gain){gain.gain.value=volume;audio.volume=1;}else{if(volume>1)throw Error('当前环境不支持音量增强');audio.volume=volume;}},resume(){return context?.resume();}};
}
