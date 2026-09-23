import { validateModules } from './adapters.js';
export const KEY='amin_os_saves_v1';
export const FORMAT='amin-os-save';
export const LIMITS=Object.freeze({saves:20,backups:5,snapshotBytes:8*1024*1024,storeBytes:24*1024*1024});
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const forbidden=new Set(['__proto__','constructor','prototype']);
export function validateJSON(value,limit=LIMITS.snapshotBytes){
    const seen=new Set();let count=0;
    function visit(v,depth){
        if(++count>500000||depth>50)throw Error('存档结构过大或嵌套过深。');
        if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
        if(typeof v!=='object'||(!Array.isArray(v)&&!object(v))||seen.has(v))throw Error('存档必须是有效 JSON 数据。');
        if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Array.from({length:v.length},(_,i)=>i).some(i=>!Object.hasOwn(v,i))))throw Error('存档数组不能有空位或额外字段。');
        seen.add(v);for(const key of Reflect.ownKeys(v)){if(Array.isArray(v)&&key==='length')continue;if(typeof key!=='string'||forbidden.has(key))throw Error('存档含受保护字段。');const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d))throw Error('存档含非数据字段。');visit(d.value,depth+1);}seen.delete(v);
    }
    visit(value,0);const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>limit)throw Error('存档超过大小上限，请减少资料后重试。');return value;
}
const shape=(v,allowed,label)=>{if(!object(v)||Object.keys(v).some(key=>!allowed.includes(key)))throw Error(label+'格式无效或包含未知字段。');};
const text=(v,max,label,required=false)=>{if(typeof v!=='string'||v.length>max||required&&!v.trim())throw Error(label+'无效或过长。');return v;};
export function validateSnapshot(value){
    validateJSON(value);shape(value,['format','version','id','name','note','createdAt','source','modules'],'存档');
    if(value.format!==FORMAT||value.version!==1)throw Error('存档版本或类型不兼容。');
    text(value.id,100,'存档编号',true);text(value.name,120,'存档名称',true);text(value.note,2000,'存档备注');text(value.createdAt,100,'创建时间',true);
    if(!Number.isFinite(Date.parse(value.createdAt)))throw Error('存档创建时间无效。');
    shape(value.source,['identity','floor','candidate'],'来源');text(value.source.identity,2000,'来源聊天',true);
    if(!Number.isInteger(value.source.floor)||value.source.floor<0||!Number.isInteger(value.source.candidate)||value.source.candidate<0)throw Error('存档来源楼层无效。');
    validateModules(value.modules);return clone(value);
}
export const empty=()=>({version:1,saves:[],backups:[]});
export function validateStore(value){
    validateJSON(value,LIMITS.storeBytes);shape(value,['version','saves','backups'],'存档库');
    if(value.version!==1||!Array.isArray(value.saves)||!Array.isArray(value.backups)||value.saves.length>LIMITS.saves||value.backups.length>LIMITS.backups)throw Error('存档库版本、格式或数量不兼容。');
    const ids=new Set();for(const item of [...value.saves,...value.backups]){validateSnapshot(item);if(ids.has(item.id))throw Error('存档编号重复。');ids.add(item.id);}return clone(value);
}
export function readStore(ctx){return ctx?.chatMetadata?.[KEY]===undefined?empty():validateStore(ctx.chatMetadata[KEY]);}
export function parseImport(raw){
    if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>LIMITS.snapshotBytes)throw Error('导入文件无效或超过 8 MiB。');
    let value;try{value=JSON.parse(raw);}catch{throw Error('导入文件不是有效 JSON。');}return validateSnapshot(value);
}
