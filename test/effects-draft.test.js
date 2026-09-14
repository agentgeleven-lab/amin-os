import test from 'node:test';
import assert from 'node:assert/strict';
import {draftRule} from '../apps/effects/draft.js';
const entry={book:'技能书',content:'原文：持续至解除'};
test('rule drafting uses full selected source and shared AI without persisting anything',async()=>{
 const ctx={chatMetadata:{}},before=JSON.stringify({ctx,entry});let received;
 const ai={capture:()=>({preset:'selected'}),generate:async(...args)=>{received=args;return ' 新草稿 ';}};
 assert.equal(await draftRule({ai,ctx,entry,name:'技能',current:'已有规则',instruction:'简短'}),'新草稿');
 assert.match(received[2].prompt,/原文：持续至解除/);assert.match(received[2].prompt,/已有规则/);assert.equal(received[3].includeEffects,false);assert.deepEqual(received[3].snapshot,{preset:'selected'});
 assert.equal(JSON.stringify({ctx,entry}),before);
});
test('cancelled, empty or stale results cannot become drafts',async()=>{
 const controller=new AbortController();const ai={capture:()=>({}),generate:async()=>{controller.abort();return 'late';}};
 await assert.rejects(draftRule({ai,entry,signal:controller.signal}),/取消/);
 ai.generate=async()=>'';await assert.rejects(draftRule({ai,entry}),/空内容/);
 let calls=0;ai.generate=async()=> 'late';await assert.rejects(draftRule({ai,entry,check(){if(++calls>1)throw Error('stale');}}),/stale/);
});
