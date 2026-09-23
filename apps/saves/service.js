import { KEY,FORMAT,LIMITS,readStore,validateStore,validateSnapshot,parseImport } from './model.js';
import { MODULE_LABELS,SNAPSHOT_PATHS,RESTORE_DEPENDENCIES,materialize,restorePatches,moduleChanges } from './adapters.js';
import { createOperationService,chatIdentity,subscribeStateChanges } from '../shared/operations.js';
import { uuid } from '../../uuid.js';
import { assertMapReady } from '../map/src/integrations/runtime.js';
const clone=value=>structuredClone(value);
export function createSavesService(getContext=()=>globalThis.SillyTavern?.getContext?.(),{createId=uuid,now=()=>new Date().toISOString()}={}){
    const operations=createOperationService(getContext),listeners=new Set();
    const notify=()=>{for(const fn of listeners){try{fn();}catch{}}};
    const off=operations.subscribe(notify),offState=subscribeStateChanges(notify);
    const capture=()=>operations.capture([[KEY],...RESTORE_DEPENDENCIES]);
    function snapshot(ctx,{name,note=''}){return validateSnapshot({format:FORMAT,version:1,id:createId(),name:String(name??'').trim(),note,createdAt:now(),source:{identity:chatIdentity(ctx),floor:ctx.chat?.length??0,candidate:ctx.chat?.at(-1)?.swipe_id??0},modules:materialize(ctx)});}
    function find(id){const store=readStore(getContext()),value=[...store.saves,...store.backups].find(item=>item.id===id);if(!value)throw Error('存档已不存在。');return value;}
    function stageStore(label,store,summary,token){validateStore(store);return operations.stage({label,patches:[{path:[KEY],value:store}],summary},token);}
    function stageSave(input,token=capture()){
        const ctx=operations.check(token),store=readStore(ctx),saved=snapshot(ctx,input);
        if(store.saves.length>=LIMITS.saves)throw Error(`最多保留 ${LIMITS.saves} 个命名存档，请先导出或删除旧存档。`);
        store.saves.push(saved);return stageStore('建立当前剧情存档',store,{kind:'save',name:saved.name,snapshot:{id:saved.id,name:saved.name,createdAt:saved.createdAt,source:saved.source},moduleNames:Object.keys(MODULE_LABELS).filter(k=>saved.modules[k]!==null).map(k=>MODULE_LABELS[k]),changes:[],warnings:[]},token);
    }
    function stageRestore(input,token=capture()){
        const ctx=operations.check(token),saved=typeof input==='string'?find(input):validateSnapshot(input),store=readStore(ctx),before=materialize(ctx);
        if(saved.modules.map!==null||ctx.chatMetadata.dynamicMapV1!==undefined)assertMapReady(ctx,{allowEmpty:true});
        const backup=snapshot(ctx,{name:('恢复前 · '+saved.name).slice(0,120),note:'自动备份：在当前楼层应用存档前的剧情状态。'});
        const {patches,warnings}=restorePatches(ctx,saved.modules,{at:now(),makeId:createId});
        const projected={...ctx,chatMetadata:clone(ctx.chatMetadata)};
        for(const patch of patches){let parent=projected.chatMetadata;for(const key of patch.path.slice(0,-1)){parent[key]??={};parent=parent[key];}if(patch.remove)delete parent[patch.path.at(-1)];else parent[patch.path.at(-1)]=clone(patch.value);}
        const effective=materialize(projected);
        store.backups.push(backup);store.backups=store.backups.slice(-LIMITS.backups);validateStore(store);
        if(saved.source.identity!==chatIdentity(ctx))warnings.push('来源为其他聊天；只应用插件剧情状态，不导入原聊天消息。');
        return operations.stage({label:'将存档应用到当前楼层',patches:[...patches,{path:[KEY],value:store}],summary:{kind:'restore',name:saved.name,source:clone(saved.source),backup:{id:backup.id,name:backup.name,createdAt:backup.createdAt},moduleNames:Object.keys(MODULE_LABELS).filter(k=>saved.modules[k]!==null).map(k=>MODULE_LABELS[k]),changes:moduleChanges(before,effective),warnings}},token);
    }
    function stageImport(raw,token=capture()){
        const ctx=operations.check(token),store=readStore(ctx),saved=parseImport(raw);
        if(store.saves.length>=LIMITS.saves)throw Error('存档数量已达上限。');
        if([...store.saves,...store.backups].some(item=>item.id===saved.id))throw Error('该存档编号已存在，请使用已有存档。');
        store.saves.push(saved);return stageStore('导入存档到当前聊天',store,{kind:'import',name:saved.name,snapshot:{id:saved.id,name:saved.name,createdAt:saved.createdAt,source:saved.source},moduleNames:Object.keys(MODULE_LABELS).filter(k=>saved.modules[k]!==null).map(k=>MODULE_LABELS[k]),changes:[],warnings:['导入仅添加存档，恢复需要另行预览确认。']},token);
    }
    function stageDelete(id,token=capture()){
        const ctx=operations.check(token),store=readStore(ctx),saved=find(id);store.saves=store.saves.filter(item=>item.id!==id);store.backups=store.backups.filter(item=>item.id!==id);
        return stageStore('删除存档',store,{kind:'delete',name:saved.name,changes:[],warnings:[]},token);
    }
    function confirm(){if(operations.preview()?.patches.some(patch=>patch.path[0]==='dynamicMapV1'))assertMapReady(getContext(),{allowEmpty:true});return operations.confirm();}
    return {context:getContext,capture,check:operations.check,read:()=>readStore(getContext()),stageSave,stageRestore,stageImport,stageDelete,
        inspectImport:parseImport,exportSave:id=>JSON.stringify(validateSnapshot(find(id)),null,2),preview:operations.preview,confirm,retrySave:operations.retrySave,discard:operations.discard,status:operations.status,busy:operations.busy,dirty:operations.dirty,
        subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){off();offState();operations.dispose();listeners.clear();}};
}
let shared;
export const getSharedSavesService=getContext=>shared??=createSavesService(getContext);
