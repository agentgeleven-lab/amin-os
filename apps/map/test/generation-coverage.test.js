import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMapGenerationPrompt,coverageInstruction} from '../src/core/generation-prompt.js';
import {createMap,createNode} from '../src/core/protocol.js';
import {applyGeneratedMap} from '../src/core/map-generation.js';
import {createDemoDocument} from '../src/core/demo.js';
const document=()=>{const sample=createDemoDocument(),map=createMap('region','地区','graph');map.metadata=structuredClone(sample.maps[sample.activeMap].metadata);return {version:1,activeMap:'region',maps:{region:map}};};
test('default map coverage is comprehensive and the small schema example is not a node limit',()=>{
 const prompt=buildMapGenerationPrompt(document());
 assert.match(prompt,/全面覆盖/);assert.match(prompt,/所有属于本次范围的明确地点/);
 assert.match(prompt,/不是数量模板/);assert.doesNotMatch(prompt,/优先 3–8|总节点不超过 12/);
 assert.match(prompt,/不为凑数虚构地点/);assert.match(prompt,/不联网/);
 assert.match(buildMapGenerationPrompt(document(),{coverage:'brief'}),/简略概览/);
 assert.match(coverageInstruction('balanced'),/主要分区/);assert.throws(()=>coverageInstruction('invalid'));
});
test('full generation preserves a larger location set rather than truncating it',()=>{
 const base=document(),generated=document(),map=generated.maps.region;
 for(let i=0;i<30;i++){const id='place_'+i;map.nodes[id]=createNode(id,'地点'+i,{type:map.metadata.nodeTypes[0].id});}
 const applied=applyGeneratedMap(base,generated);
 assert.equal(Object.keys(applied.maps.region.nodes).length,30);
 assert.equal(Object.keys(base.maps.region.nodes).length,0);
});
