// Execute the installed LittleWhiteBox State 2.0 engine against isolated in-memory host mocks.
// No real chat, settings, worldbook or extension files are modified.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
import {createStore} from '../service.js';import {ROOT,empty,entity} from '../model.js';
const lwb=process.env.AMIN_LWB_PATH;if(!lwb)throw Error('Set AMIN_LWB_PATH to the installed LittleWhiteBox directory');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amin-lwb-integration-'));
fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
fs.writeFileSync(path.join(dir,'env.js'),`export let ctx;export function setContext(c){ctx=c;}export function getContext(){return ctx;}export function getLocalVariable(k){return ctx.chatMetadata.variables[k]??'';}export function setLocalVariable(k,v){ctx.chatMetadata.variables[k]=v;}`);
for(const file of ['parser.js','semantic.js','guard-core.js','guard.js','executor.js']){
 let code=fs.readFileSync(path.join(lwb,'modules/variables/state2',file),'utf8');
 code=code.replace("import jsyaml from '../../../libs/js-yaml.mjs';",'import jsyaml from '+JSON.stringify(pathToFileURL(path.join(lwb,'libs/js-yaml.mjs')).href)+';');
 code=code.replace("from '../../../../../../extensions.js'","from './env.js'").replace("from '../../../../../../variables.js'","from './env.js'");fs.writeFileSync(path.join(dir,file),code);
}
const env=await import(pathToFileURL(path.join(dir,'env.js')).href),engine=await import(pathToFileURL(path.join(dir,'executor.js')).href);
const ctx={chatId:'fixture',getCurrentChatId:()=> 'fixture',chat:[{mes:'开场',swipe_id:0}],characterId:0,characters:[{avatar:'fixture.png'}],extensionSettings:{LittleWhiteBox:{variablesMode:'2.0'}},chatMetadata:{variables:{other:'preserve'},LWB_RULES_V2:{},extensions:{}},saveMetadata:async()=>{},saveMetadataDebounced(){},saveChat:async()=>{}};env.setContext(ctx);
const api=createStore({context:()=>ctx,setVariable:env.setLocalVariable});
const doc=empty();doc.organizations.org_a=entity('organizations','商会');doc.organizations.org_a.background='必须保留的建档资料';doc.regions.port=entity('regions','港口');doc.regions.port.controllers=[{organization:'org_a',role:'经营',note:''}];
api.stage(doc,api.capture(),{manual:true});await api.confirm();
ctx.chat.push({mes:'营业恢复',swipe_id:0});api.sync();
const output=engine.applyStateForMessage(1,'<state>\n势力资料.organizations.org_a.status: "营业恢复"\n势力资料.regions.port.controllers: [{"organization":"org_a","role":"经营","note":"新合同"}]\n</state>');
api.sync();assert.equal(api.read().organizations.org_a.status,'营业恢复',JSON.stringify(output));assert.equal(api.read().regions.port.controllers[0].note,'新合同');assert.equal(api.read().organizations.org_a.background,'必须保留的建档资料');assert.equal(ctx.chatMetadata.variables.other,'preserve');
await engine.restoreStateV2ToFloor(0);assert.equal(api.read().organizations.org_a.status,'');assert.equal(api.read().organizations.org_a.background,'必须保留的建档资料');assert.equal(ctx.chatMetadata.variables.other,'preserve');
await engine.restoreStateV2ToFloor(1);assert.equal(api.read().organizations.org_a.status,'营业恢复');assert.equal(api.read().regions.port.controllers[0].note,'新合同');
ctx.chat.pop();api.sync();assert.equal(api.read().organizations.org_a.status,'');assert.equal(ctx.chatMetadata.variables.other,'preserve');api.dispose();
console.log('PASS installed LittleWhiteBox State 2.0: leaf updates, object-array links, front-end checkpoints, replay/rollback and unrelated variable preservation.');
