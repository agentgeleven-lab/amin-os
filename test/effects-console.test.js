import test from 'node:test';
import assert from 'node:assert/strict';
import {appearance,reorder} from '../apps/effects/console.js';
import {empty,change,activeEffects,compile} from '../apps/effects/model.js';
test('legacy skills become buttons without changing original rule or effect data',()=>{
 const skill={id:'old',name:'视觉',original:'原文',reminder:'规则'};const before=JSON.stringify(skill);
 assert.equal(appearance(skill).size,'medium');assert.equal(appearance(skill).scope,'视觉');assert.equal(JSON.stringify(skill),before);
});
test('reordering moves across groups while preserving unrelated skills and button settings',()=>{
 const skills=[{id:'a',name:'A',ui:{group:'一',icon:'★',size:'wide'}},{id:'b',name:'B',ui:{group:'二'}},{id:'c',name:'C'}];
 const before=JSON.stringify(skills),result=reorder(skills,'a','b',true);
 assert.deepEqual(result.map(s=>s.id),['b','a','c']);assert.equal(result[1].ui.group,'二');assert.equal(result[1].ui.icon,'★');assert.equal(result[1].ui.size,'wide');assert.equal(JSON.stringify(skills),before);
});
test('pause keeps ownership record but removes prompt until explicitly resumed',()=>{
 const chat=[{mes:'one'}],store={...empty(),skills:[{id:'s',name:'能力',book:'自定义能力',entryId:'1',reminder:'保留规则'}]};
 const added=change(store,chat,'create',{skillId:'s',holder:'a',target:'b',scope:'视觉',condition:'直到解除'}),id=activeEffects(added,chat)[0].id;
 const paused=change(added,chat,'pause',{id,paused:true});assert.equal(activeEffects(paused,chat).length,1);assert.equal(compile(paused,chat),'');
 const resumed=change(paused,chat,'pause',{id,paused:false});assert.match(compile(resumed,chat),/保留规则/);
});
