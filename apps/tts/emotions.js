export const EMOTIONS=[
 ['日常','语气自然亲切，轻松交流。'],
 ['温柔','语气柔和，像认真安慰朋友，避免夸张气声。'],
 ['开心','语调轻快，带自然笑意。'],
 ['小吐槽','略带无奈和玩笑，重音清楚，不尖叫。'],
 ['活泼','节奏明快，富有朝气，吐字清楚。'],
 ['俏皮','轻巧灵动，带一点调皮和逗趣感。'],
 ['撒娇','语气亲昵柔软，尾音轻柔，保持成年女性声线。'],
 ['害羞','略带迟疑，声音轻柔，情绪含蓄，不拖长每个字。'],
 ['平静','情绪克制，声音平稳，语句连贯。'],
 ['认真','清晰坚定，重点突出，像认真解释一件事。'],
 ['冷淡','语气疏离克制，起伏较少，避免机械朗读。'],
 ['低语','轻声近距离说话，咬字清楚，避免过多气声。'],
 ['悲伤','低落而克制，略带哽咽感，保持文字清晰。'],
 ['生气','明显不满，重音有力，控制音量，不尖叫。'],
 ['惊讶','自然惊讶，重点词上扬，避免夸张喊叫。'],
 ['紧张','带紧张和急切感，停顿短促，保持可懂度。'],
 ['安慰','耐心温暖，语气笃定，像在安慰熟悉的人。'],
 ['讲故事','有叙述感，重点和转折自然，避免播音腔。'],
];
export function emotionText(value){return EMOTIONS.find(([name])=>name===value)?.[1]||value||'自然亲切';}
export function speedMax(provider){return ['mimo','mimo-direct'].includes(provider)?2:1.3;}
// The existing local studio accepts four labels. Put custom direction in its
// supported voice prompt, so users do not have to restart it or lose its key.
export function localEmotion(prompt,value='日常'){
 if(['日常','温柔','开心','小吐槽'].includes(value))return {prompt,emotion:value};
 return {prompt:prompt+'\n本段演绎要求（优先于默认日常语气，保持基础音色）：'+emotionText(value),emotion:'日常'};
}
