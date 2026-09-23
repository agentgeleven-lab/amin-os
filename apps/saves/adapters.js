import * as Characters from '../characters/model.js';
import * as Inventory from '../inventory/model.js';
import * as Relationships from '../relationships/model.js';
import * as Scene from '../scene/model.js';
import * as Effects from '../effects/model.js';
import * as Journal from '../journal/model.js';
import * as Information from '../information/model.js';
import * as Organizations from '../organizations/model.js';
import { validateTemplate } from '../status/state-tools.js';
import { validateDocument } from '../map/src/core/protocol.js';
import { normalizeConfig } from '../dice/engine.js';
import { uuid } from '../../uuid.js';

const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const MODULE_LABELS = Object.freeze({ characters:'角色档案', inventory:'物品与经济', relationships:'人物关系', scene:'场景与时间', effects:'持续效果', journal:'剧情档案', dice:'固定骰点', map:'地图', status:'世界状态', organizations:'势力资料', information:'信息面板', informationLibrary:'信息资料库' });
const keys = { characters:Characters.KEY, inventory:Inventory.KEY, relationships:Relationships.KEY, scene:Scene.KEY, effects:Effects.KEY, journal:Journal.KEY, dice:'amin_os_dice_v1', map:'dynamicMapV1', information:Information.KEY, informationLibrary:Information.LIBRARY_KEY };
export const SNAPSHOT_PATHS = Object.freeze([...Object.values(keys).map(key => [key]), ['variables','状态栏'], ['variables','势力资料'], ['amin_os_organizations_v1']]);
export const RESTORE_DEPENDENCIES = Object.freeze([...SNAPSHOT_PATHS, ['dynamicMapPositionHistoryV1']]);
const rootShape = (v, allowed, label) => { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) throw Error(label+'包含未知字段或格式无效。'); };
const version = (v, allowed, label) => { rootShape(v, allowed, label); if (v.version !== 1) throw Error(label+'版本不兼容。'); };
const list = (v, max, label) => { if (!Array.isArray(v) || v.length > max) throw Error(label+'不是有效列表或超过上限。'); };
const unique = (v, label) => { if (new Set(v.map(x => x.id)).size !== v.length) throw Error(label+'编号重复。'); };
const bounded = (v, min, max, label) => { if (!Number.isInteger(v) || v < min || v > max) throw Error(label+'超出有效范围。'); };
const readRaw = (ctx,key) => ctx.chatMetadata[key];

function validateJournal(input) {
    version(input,['version','limit','entries'],'剧情档案'); bounded(input.limit,1,10000000,'档案提示上限'); list(input.entries,2000,'剧情档案'); unique(input.entries,'剧情档案');
    for (const entry of input.entries) {
        const allowed=['id','kind','title','body','enabled','confirmed','actors','gameTime','gameTimeText','sourceNote','sources','status','remindAfter'];
        rootShape(entry,allowed,'档案条目');
        if (entry.confirmed !== true || typeof entry.enabled !== 'boolean') throw Error('档案确认状态无效。');
        Journal.validateRecord({...entry,enabled:false,sources:null},[]);
        if (entry.sources !== null) {
            const s=entry.sources; rootShape(s,['start','end','messages'],'档案来源');
            bounded(s.start,0,1000000,'来源起点');bounded(s.end,s.start,1000000,'来源终点');list(s.messages,100000,'来源消息');
            if(s.messages.length!==s.end-s.start+1)throw Error('档案来源不完整。');
            for(const [offset,m]of s.messages.entries())if(!object(m)||m.index!==s.start+offset||typeof m.text!=='string'||typeof m.revision!=='string'||typeof m.name!=='string'||typeof m.isUser!=='boolean'||!Number.isInteger(m.swipeId))throw Error('档案来源消息格式无效。');
        }
    }
    return clone(input);
}
function validateDice(input) {
    version(input,['version','rolls'],'骰点');list(input.rolls,5000,'骰点');unique(input.rolls,'骰点');
    for(const r of input.rolls){
        rootShape(r,['id','createdAt','settings','results','status','rerollOf','text','pending','sent'],'骰点记录');
        if(typeof r.id!=='string'||!r.id||typeof r.text!=='string'||!r.text||r.text.length>100000||!Number.isFinite(r.createdAt)||!['rolled','appended','sent',undefined].includes(r.status))throw Error('骰点记录无效。');
        normalizeConfig(r.settings);list(r.results,100,'骰点结果');if(!r.results.length||r.results.some(v=>!object(v)||!Number.isFinite(v.total)))throw Error('骰点结果无效。');
        if(r.sent!==undefined&&(!object(r.sent)||!Number.isInteger(r.sent.messageIndex)||r.sent.messageIndex<0||typeof r.sent.messageText!=='string'||!Number.isFinite(r.sent.at)))throw Error('骰点发送依据无效。');
        if(r.pending!==undefined&&(!object(r.pending)||typeof r.pending.chatKey!=='string'||!Number.isInteger(r.pending.firstIndex)||r.pending.firstIndex<0))throw Error('骰点草稿依据无效。');
    }return clone(input);
}
function validateInformation(input) {
    version(input,['version','enabled','limit','records'],'信息面板'); if(typeof input.enabled!=='boolean')throw Error('信息面板开关无效。');bounded(input.limit,1,10000000,'信息提醒上限');list(input.records,1000,'信息面板');unique(input.records,'信息面板');
    for(const record of input.records)Information.validateRecord(record);return clone(input);
}
function validateOrganizations(input) {
    version(input,['version','doc','locks','assessment'],'势力快照');Organizations.validate(input.doc);list(input.locks,10000,'势力锁定字段');if(input.locks.some(p=>typeof p!=='string'))throw Error('势力锁定字段无效。');
    if(input.assessment!==null&&!object(input.assessment))throw Error('势力评估无效。');return clone(input);
}
export function validateModules(modules) {
    rootShape(modules,Object.keys(MODULE_LABELS),'存档模块');
    if(Object.keys(modules).length!==Object.keys(MODULE_LABELS).length)throw Error('存档模块不完整。');
    for(const [name,value]of Object.entries(modules)){
        if(value===null)continue;
        if(name==='characters')Characters.validateState(value);
        else if(name==='inventory')Inventory.validateState(value);
        else if(name==='relationships')Relationships.validateState(value);
        else if(name==='scene'){rootShape(value,['version','clock','periods','scenes','activeSceneId','settings'],'场景快照');Scene.validateState(value);}
        else if(name==='effects'){rootShape(value,['version','enabled','limit','effects','consumedActionIds'],'持续效果快照');Effects.validateEffectsSnapshot(value);}
        else if(name==='journal')validateJournal(value);
        else if(name==='dice')validateDice(value);
        else if(name==='map')validateDocument(value);
        else if(name==='status'){if(value.版本!==undefined&&value.版本!==1)throw Error('世界状态版本不兼容。');validateTemplate(value);}
        else if(name==='organizations')validateOrganizations(value);
        else if(name==='information')validateInformation(value);
        else if(name==='informationLibrary'){list(value,1000,'信息资料库');for(const entry of value){rootShape(entry,['record','search','at'],'资料收纳');Information.validateRecord(entry.record);if(typeof entry.at!=='string')throw Error('资料时间无效。');}}
    }return clone(modules);
}
export function materialize(ctx) {
    const meta=ctx.chatMetadata, result=Object.fromEntries(Object.keys(MODULE_LABELS).map(k=>[k,null]));
    // Legacy readers sometimes coalesce null/false into an empty store. An
    // explicit malformed root must never be treated as an absent module here.
    for(const [name,key]of Object.entries(keys))if(own(meta,key)){
        if(name==='informationLibrary'){if(!Array.isArray(meta[key]))throw Error('信息资料库原始数据格式不兼容，未改写。');}
        else if(!object(meta[key]))throw Error(MODULE_LABELS[name]+'原始数据格式不兼容，未改写。');
    }
    if(own(meta,'amin_os_organizations_v1')&&!object(meta.amin_os_organizations_v1))throw Error('势力元数据格式不兼容，未改写。');
    const readers={characters:Characters.readCharacters,inventory:Inventory.readInventory,relationships:Relationships.readRelationships,scene:Scene.readCurrentScene};
    for(const [name,read]of Object.entries(readers))if(own(meta,keys[name]))result[name]=read(ctx);
    if(own(meta,Effects.KEY))result.effects=Effects.snapshotEffects(Effects.readStore(ctx),ctx.chat);
    if(own(meta,Journal.KEY)){const store=Journal.readStore(ctx);result.journal={version:1,limit:store.limit,entries:Journal.currentEntries(store,ctx.chat).map(({savedAt,savedFloor,eventId,...record})=>record)};}
    if(own(meta,keys.dice))result.dice=validateDice(readRaw(ctx,keys.dice));
    if(own(meta,keys.map)){const envelope=readRaw(ctx,keys.map);rootShape(envelope,['updatedAt','document'],'地图存储');if(!Number.isFinite(envelope.updatedAt))throw Error('地图版本时间无效。');result.map=validateDocument(envelope.document);}
    if(own(meta.variables??{},'状态栏')){const raw=meta.variables.状态栏;result.status=typeof raw==='string'?JSON.parse(raw):clone(raw);}
    if(own(meta.variables??{},Organizations.ROOT)){const extra=meta.amin_os_organizations_v1??{};result.organizations={version:1,doc:Organizations.read(meta.variables[Organizations.ROOT]),locks:clone(extra.locks??[]),assessment:clone(extra.assessment??null)};}
    if(own(meta,Information.KEY)){const store=Information.read(ctx);result.information={version:1,enabled:store.enabled,limit:store.limit,records:Information.current(store,ctx.chat)};}
    if(own(meta,Information.LIBRARY_KEY))result.informationLibrary=Information.library(ctx);
    return validateModules(result);
}

function restoreJournal(ctx, value, at, makeId, warnings) {
    const store=Journal.readStore(ctx), target=value??{version:1,limit:40000,entries:[]}, existing=Journal.currentEntries(store,ctx.chat), next=clone(store);
    next.limit=target.limit;
    for(const old of existing)next.events.push({id:makeId(),op:'delete',recordId:old.id,path:Journal.path(ctx.chat),at});
    for(const entry of target.entries){
        let record=clone(entry);
        if(record.sources&&!Journal.sourceState(record.sources,ctx.chat).valid){record={...record,enabled:false,sources:null,sourceNote:[record.sourceNote,'存档恢复：原聊天来源已失效，请重新绑定当前楼层后启用引用。'].filter(Boolean).join('\n').slice(0,1000)};warnings.push('部分剧情档案的原消息来源不匹配，已关闭引用并保留正文。');}
        record=Journal.validateRecord(record,ctx.chat);next.events.push({id:makeId(),op:'update',recordId:record.id,path:Journal.path(ctx.chat),at,record});
    }return next;
}
function restoreInformation(ctx,value,at,makeId){
    let next=Information.read(ctx);const target=value??{version:1,enabled:true,limit:40000,records:[]};
    for(const old of Information.current(next,ctx.chat))next.history.push({id:makeId(),recordId:old.id,path:Information.path(ctx.chat),at,reason:'存档恢复清除当前面板',action:'reset',snapshot:null});
    for(const record of target.records)next=Information.apply(next,ctx.chat,record,'存档恢复到当前楼层');
    next.enabled=target.enabled;next.limit=target.limit;return next;
}
function positionHistory(ctx, document) {
    const original=ctx.chatMetadata.dynamicMapPositionHistoryV1;
    if(original!==undefined&&(!object(original)||!object(original.records)||original.sequence!==undefined&&!Array.isArray(original.sequence)))throw Error('地图位置历史格式不兼容。');
    const sequence=(ctx.chat??[]).map(m=>m.extra?.dynamic_map_message_id?m.extra.dynamic_map_message_id+':'+String(m.swipe_id??0):null);
    // UUID creation remains the host bridge's job. No message mutation in a metadata transaction.
    if(sequence.some(v=>v===null))return {records:{},sequence:[]};
    const next=clone(original??{records:{}});next.sequence=sequence;
    if(sequence.length){const active=document?.maps?.[document.activeMap];next.records[sequence.at(-1)]={mapId:document?.activeMap??null,nodeId:active?.currentLocation??null};}
    return next;
}
export function restorePatches(ctx, modules, {at=new Date().toISOString(),makeId=uuid}={}) {
    validateModules(modules);materialize(ctx); // Refuse corrupt/newer existing data before creating any replacement.
    const patches=[],warnings=[],put=(path,value)=>patches.push({path,value}),remove=path=>patches.push({path,remove:true});
    for(const[name,builder,empty]of [['characters',Characters.buildRestore,Characters.emptyState],['inventory',Inventory.buildRestoreStore,Inventory.emptyState],['relationships',Relationships.buildRestore,Relationships.emptyState]]){
        if(modules[name]!==null||own(ctx.chatMetadata,keys[name]))put([keys[name]],builder(ctx,modules[name]??empty(),{id:makeId(),at,reason:'存档恢复到当前楼层'}));
    }
    if(modules.scene!==null||own(ctx.chatMetadata,Scene.KEY)){const state=modules.scene??Scene.emptyState();put([Scene.KEY],Scene.appendEvent(Scene.readStore(ctx),ctx.chat,{op:'restore',reason:'存档恢复到当前楼层',state,details:{beforeTime:Scene.readCurrentScene(ctx).clock,afterTime:state.clock}},{eventId:makeId(),at}));}
    if(modules.effects!==null||own(ctx.chatMetadata,Effects.KEY))put([Effects.KEY],Effects.restoreEffects(ctx.chatMetadata[Effects.KEY]??Effects.empty(),ctx.chat,modules.effects??Effects.snapshotEffects(Effects.empty(),[]),{operationId:makeId(),at}));
    if(modules.journal!==null||own(ctx.chatMetadata,Journal.KEY))put([Journal.KEY],restoreJournal(ctx,modules.journal,at,makeId,warnings));
    if(modules.information!==null||own(ctx.chatMetadata,Information.KEY))put([Information.KEY],restoreInformation(ctx,modules.information,at,makeId));
    if(modules.informationLibrary!==null)put([Information.LIBRARY_KEY],modules.informationLibrary);else if(own(ctx.chatMetadata,Information.LIBRARY_KEY))remove([Information.LIBRARY_KEY]);
    if(modules.dice!==null){const dice=clone(modules.dice);for(const roll of dice.rolls){if(roll.status==='appended')roll.status='rolled';delete roll.pending;}put([keys.dice],dice);if(modules.dice.rolls.some(r=>r.status==='appended'))warnings.push('已追加草稿的骰点恢复为固定未追加状态；聊天输入框不会改写。');}else if(own(ctx.chatMetadata,keys.dice))remove([keys.dice]);
    if(modules.map!==null){const updatedAt=Math.max(Date.now(),(ctx.chatMetadata.dynamicMapV1?.updatedAt??0)+1);put([keys.map],{updatedAt,document:modules.map});}else if(own(ctx.chatMetadata,keys.map))remove([keys.map]);
    if(modules.map!==null||own(ctx.chatMetadata,keys.map))put(['dynamicMapPositionHistoryV1'],positionHistory(ctx,modules.map));
    if(modules.status!==null)put(['variables','状态栏'],JSON.stringify(modules.status));else if(own(ctx.chatMetadata.variables??{},'状态栏'))remove(['variables','状态栏']);
    if(modules.organizations!==null){put(['variables',Organizations.ROOT],JSON.stringify(modules.organizations.doc));put(['amin_os_organizations_v1','locks'],modules.organizations.locks);put(['amin_os_organizations_v1','assessment'],modules.organizations.assessment);}
    else if(own(ctx.chatMetadata.variables??{},Organizations.ROOT)){remove(['variables',Organizations.ROOT]);put(['amin_os_organizations_v1','locks'],[]);put(['amin_os_organizations_v1','assessment'],null);}
    return {patches,warnings:[...new Set(warnings)]};
}
export function describeModule(name,value){
    if(value===null)return '未建立';
    if(name==='characters')return value.characters.length+' 个角色';if(name==='inventory')return `${value.items.length} 种物品 · ${value.balances.length} 项余额 · ${value.ledger.length} 条账目`;
    if(name==='relationships')return value.relationships.length+' 条关系';if(name==='scene')return Scene.formatGameTime(value.clock,value.periods)+' · '+Object.keys(value.scenes).length+' 个场景';
    if(name==='effects')return value.effects.length+' 条效果';if(name==='journal')return value.entries.length+' 条档案';if(name==='dice')return value.rolls.length+' 条骰点';if(name==='map')return Object.keys(value.maps).length+' 张地图';
    if(name==='status')return Object.values(value.项目).reduce((sum,fields)=>sum+Object.keys(fields).length,0)+' 个字段';if(name==='organizations')return Organizations.GROUPS.reduce((sum,key)=>sum+Object.keys(value.doc[key]).length,0)+' 个主体';if(name==='information')return value.records.length+' 个面板';return value.length+' 条资料';
}
function fieldChanges(before,after){
    const details=[];let total=0;
    const shown=value=>{if(value===undefined)return {text:'（不存在）',truncated:false};const full=typeof value==='string'?value:JSON.stringify(value);return {text:full.length>320?full.slice(0,320)+'…（已截断）':full,truncated:full.length>320};};
    function walk(a,b,path){
        if(JSON.stringify(a)===JSON.stringify(b))return;
        if((object(a)&&object(b))||(Array.isArray(a)&&Array.isArray(b))){for(const key of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[key],b[key],path?path+'.'+key:key);return;}
        total++;if(details.length>=40)return;const left=shown(a),right=shown(b);details.push({path:path||'整个模块',before:left.text,after:right.text,beforeTruncated:left.truncated,afterTruncated:right.truncated});
    }
    walk(before,after,'');return {details,omitted:total-details.length};
}
export function moduleChanges(before,after){return Object.keys(MODULE_LABELS).filter(name=>JSON.stringify(before[name])!==JSON.stringify(after[name])).map(module=>({module,label:MODULE_LABELS[module],changed:true,before:describeModule(module,before[module]),after:describeModule(module,after[module]),...fieldChanges(before[module],after[module])}));}
