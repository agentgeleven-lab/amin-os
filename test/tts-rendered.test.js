import test from 'node:test';
import assert from 'node:assert/strict';
import {readRenderedMessage} from '../apps/tts/rendered-text.js';
const doc={defaultView:{getComputedStyle:n=>({display:'inline',visibility:'visible',opacity:'1',...n.style})}};
const txt=nodeValue=>({nodeType:3,nodeValue});
function el(tagName,childNodes=[],style={},excluded=false){return {nodeType:1,tagName,childNodes,style,ownerDocument:doc,isConnected:true,matches:()=>excluded,get children(){return this.childNodes.filter(x=>x.nodeType===1);}};}
const message=root=>({querySelector:selector=>selector==='.mes_text'?root:null,mes:'原始消息里被正则删除的秘密'});
test('floor speech uses rendered replacements, hides CSS nodes and ignores controls',()=>{
 const root=el('DIV',[el('P',[txt('正则替换后的正文。')],{display:'block'}),el('SPAN',[txt('正则隐藏内容')],{display:'none'}),el('SPAN',[txt('不可见')],{visibility:'hidden'}),el('BUTTON',[txt('地图 设置 播放')],{},true),el('P',[txt('下一段。')],{display:'block'})]);
 assert.equal(readRenderedMessage(message(root)),'正则替换后的正文。\n\n下一段。');
});
test('missing or detached rendered message never falls back to original text',()=>{assert.equal(readRenderedMessage(message(null)),'');const root=el('DIV',[txt('旧正文')]);root.isConnected=false;assert.equal(readRenderedMessage(message(root)),'');});
test('closed details read visible summary only; subsequent rendering changes are read fresh',()=>{const details=el('DETAILS',[el('SUMMARY',[txt('摘要')]),txt('折叠内容')]);const root=el('DIV',[details]);assert.equal(readRenderedMessage(message(root)),'摘要');root.childNodes=[txt('新正则结果 * 3 < 4')];assert.equal(readRenderedMessage(message(root)),'新正则结果 * 3 < 4');});
