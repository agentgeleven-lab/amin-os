import {empty,entity,ROOT} from '../model.js';import {createStore,META} from '../service.js';
export function sample(){const d=empty();d.name='澜湾';d.organizations.a=entity('organizations','共和国');d.organizations.b=entity('organizations','商会');d.regions.r=entity('regions','南港');return d;}
export function harness({save=async()=>{},lwb=false}={}){
 const ctx={chatMetadata:{variables:{[ROOT]:JSON.stringify(sample()),other:'keep'},LWB_RULES_V2:{other:'rule'}},chat:[{mes:'开场',name:'角色',swipe_id:0}],characterId:0,characters:[{avatar:'a.png',data:{name:'角色',description:'世界设定'}}],groupId:null,id:'a',getCurrentChatId(){return this.id;},extensionSettings:{LittleWhiteBox:{variablesMode:lwb?'2.0':'1.0'}},saveMetadata:save,saveMetadataDebounced(){},saveSettingsDebounced(){},saveChat:async()=>{}};
 let current=ctx;const api=createStore({context:()=>current,setVariable:(k,v)=>{current.chatMetadata.variables??={};current.chatMetadata.variables[k]=v;},saveMetadata:c=>c.saveMetadata()});
 return {api,ctx,switchChat(){current={...ctx,id:'b',chat:[{mes:'其他聊天'}],chatMetadata:{variables:{[ROOT]:JSON.stringify(sample())}},getCurrentChatId(){return this.id;}};return current;},current:()=>current};
}
