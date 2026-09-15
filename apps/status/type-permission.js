import {valueType} from './state-tools.js';

// Only user-authored update requirements grant permission, never retrieved material.
export function canChangeType(config,project,field,value){
 if(config.allowTypeChange===true)return true;
 const sentences=[config.updateNote,config.instructions,config.statusRules].filter(v=>typeof v==='string').join('\n').split(/[。！？\n;；]/);
 const type=valueType(value),names={文本:'文本|字符串',数字:'数字|数值|number',布尔:'布尔|boolean',列表:'列表|数组|array',进度:'进度|progress'}[type];
 if(!names)return false;
 const negative=/(?:不允许|不准|禁止|不要|不得|不能|无需|不应|不可|不更改|不改变|不转换|勿|暂不)/;
 // A negative requirement mentioning this field takes precedence over textual permission.
 if(sentences.some(s=>negative.test(s)&&(s.includes(field)||/(?:变量|字段).*类型/.test(s))))return false;
 return sentences.some(s=>{
  if(negative.test(s))return false;
  if(/允许(?:更改|改变|修改|转换)(?:已有)?(?:字段|变量)?(?:的)?类型/.test(s))return true;
  return s.includes(field)&&new RegExp('(?:改为|改成|转为|转换为|转换成|设为|设置为|类型为)[^。！？\\n]{0,12}(?:'+names+')','i').test(s);
 });
}
