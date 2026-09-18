import {chunks} from './model.js';
export const DEFAULT_QUOTES='“”\n「」\n『』\n""';
export function quotePairs(value=DEFAULT_QUOTES){const rows=value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(rows.some(x=>[...x].length!==2))throw Error('引号规则每行填写一对符号，例如：“”');return rows.map(x=>[...x]);}
export function classify(text,rules=DEFAULT_QUOTES){
 const pairs=quotePairs(rules),chars=[...String(text)],result=[];let start=0;
 for(let i=0;i<chars.length;i++){
  const pair=pairs.find(p=>p[0]===chars[i]);if(!pair)continue;
  const stack=[pair[1]];let end=i+1;
  for(;end<chars.length;end++){const c=chars[end];if(c===stack.at(-1)){stack.pop();if(!stack.length)break;}else{const nested=pairs.find(p=>p[0]===c);if(nested)stack.push(nested[1]);}}
  if(stack.length)continue;
  if(i>start)result.push({type:'narration',text:chars.slice(start,i).join('')});
  result.push({type:'dialogue',text:chars.slice(i,end+1).join('')});start=end+1;i=end;
 }
 if(start<chars.length)result.push({type:'narration',text:chars.slice(start).join('')});return result;
}
export function profiles(config){return Object.fromEntries(['dialogue','narration'].map(type=>[type,{speed:config.speed??1,volume:config.volume??1,pauseMs:0,emotion:'日常',...config.profiles?.[type]}]));}
export function planSpeech(text,config){
 const sections=Array.isArray(text)?text:classify(text,config.quotes??DEFAULT_QUOTES),p=profiles(config);
 return sections.filter(s=>!config.range||config.range==='all'||s.type===config.range).flatMap(s=>{const parts=chunks(s.text);return parts.map((text,i)=>({text,...p[s.type],pauseMs:i===parts.length-1?p[s.type].pauseMs:0}));});
}
export function delay(ms,signal){return new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};if(signal.aborted)return resolve();signal.addEventListener('abort',done,{once:true});timer=setTimeout(done,ms);});}
