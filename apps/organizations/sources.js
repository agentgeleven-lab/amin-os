import {bookCatalog} from '../effects/books.js';
const unique=values=>[...new Set(values.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()))];
export function selectedBookNames(config){return unique(Array.isArray(config.selectedBooks)?config.selectedBooks:String(config.books??'').split(/\r?\n/));}
export async function worldbookChoices(ctx,{loadWorldInfo=()=>import('/scripts/world-info.js'),check=()=>{}}={}){
 check();const wi=await loadWorldInfo();check();
 const settings=wi.world_info??ctx.worldInfoSettings?.world_info??{};
 const globals=wi.selected_world_info??settings.globalSelect;
 if(!Array.isArray(globals))throw Error('宿主未提供当前启用的世界书列表，未用全库替代');
 const books=bookCatalog(ctx,{selected_world_info:globals,world_info:settings});
 const grouped=ctx.groupId!=null&&ctx.groupId!=='';
 return books.map(b=>({...b,automatic:!grouped&&b.sources.some(s=>['角色绑定','角色附加','角色内嵌'].includes(s))}));
}
export async function freshWorldbook(ctx,name,{fetcher=fetch,check=()=>{}}={}){
 check();if(typeof ctx.getRequestHeaders!=='function')throw Error('宿主缺少世界书请求接口，无法重新读取');
 const response=await fetcher('/api/worldinfo/get',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({name}),cache:'no-store'});check();
 if(!response.ok)throw Error('无法重新读取世界书：'+name);
 const book=await response.json();check();return book;
}
export async function collectWorldbooks(ctx,config,options={}){
 if(config.readWorldbooks===false)return [];
 const check=options.check??(()=>{}),books=await worldbookChoices(ctx,options),selected=selectedBookNames(config);
 const missing=selected.filter(name=>!books.some(b=>b.name===name));
 if(missing.length)throw Error('所选世界书当前未启用，请在生成与规则中取消勾选或先启用：'+missing.join('、'));
 const wanted=books.filter(b=>selected.includes(b.name)||(config.includeCharacter&&b.automatic));
 const result=[];
 for(const b of wanted){
  check();const book=b.data??await (options.readBook??((name)=>freshWorldbook(ctx,name,options)))(b.name);check();
  if(!book?.entries||typeof book.entries!=='object')throw Error('无法读取所选世界书：'+b.name);
  // Only the explicit enable flag filters source material. Activation strategies are not executed.
  result.push({name:b.name,entries:Object.values(book.entries).filter(e=>e&&!e.disable&&e.enabled!==false&&typeof e.content==='string').map(e=>({title:e.comment??e.name??'',content:e.content}))});
 }
 return result;
}
