import {collectWorldbooks} from '../worldbook-sources.js';
export async function collectStatusSources(ctx,config={},options={}){
 const c=ctx.characters?.[ctx.characterId],d=c?.data??{},card={};
 if(config.includeCharacter!==false)for(const [key,label]of [['name','名称'],['description','描述'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','对话示例']])card[label]=d[key]??c?.[key]??'';
 // Character text is collected above; book bodies depend only on book selection.
 const books=await collectWorldbooks(ctx,{legacyBindings:true,...config,includeCharacter:false},{...options,includeKeys:true});
 return {角色卡:card,世界书:books.map(b=>({名称:b.name,条目:b.entries.map(e=>({标题:e.title,关键词:e.keys??[],内容:e.content}))}))};
}
