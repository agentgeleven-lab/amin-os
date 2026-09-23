import { migrateState2, projectState2, manualState2Patches, MIGRATION_KEY, nativeState2Status as storageStatus } from './storage.js';
import { createOperationService, registerOperationPatchExpansion, metadataWriteStatus, acquireMetadataWrite, captureContext, publishExternalMetadataChange, chatIdentity, chatPath } from '../shared/operations.js';
export { prepareState2ManualWrite } from './storage.js';

const clone = value => structuredClone(value);
const pathKey = path => JSON.stringify(path);
const context = () => globalThis.SillyTavern?.getContext?.();
let shared;
export function nativeState2Status(ctx = context()) {
    const available = ctx?.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0' && typeof globalThis.LWB_StateV2?.applyText === 'function';
    const migrated = storageStatus(ctx).migrated;
    return { available, migrated, message: !available ? '请启用小白 X 的变量管理 2.0；Amin 不会代替小白执行变量更新。' : migrated ? '剧情数据已接入小白变量 2.0；回复中的 <state> 由小白自动执行。' : '小白变量 2.0 已就绪，尚未迁移当前聊天的应用资料。' };
}
function setPatches(metadata, patches) {
    for (const patch of patches) {
        let target = metadata;
        for (const key of patch.path.slice(0,-1)) target = target[key] ??= {};
        if (patch.remove) delete target[patch.path.at(-1)];
        else target[patch.path.at(-1)] = clone(patch.value);
    }
}
function combine(original, extra) {
    const values = new Map(original.map(p=>[pathKey(p.path),p]));
    for (const patch of extra) values.set(pathKey(patch.path),patch);
    return [...values.values()];
}
/** The native engine is the sole executor of chat <state> blocks. */
export function createState2Runtime(getContext = context, { report = () => {}, interval = 700, host = globalThis, document = globalThis.document } = {}) {
    let disposed = false, projecting = false, lastMessage = '', timer = null, lastErrors = null;
    const subscriptions = [], operation = createOperationService(getContext);
    const say = text => { if (text !== lastMessage) { lastMessage = text; report(text); } };
    const available = () => getContext()?.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0' && typeof host.LWB_StateV2?.applyText === 'function';
    const removeExpansion = registerOperationPatchExpansion((ctx, patches) => {
        if (projecting || !storageStatus(ctx).migrated) return patches;
        return combine(patches, manualState2Patches(ctx, patches).patches);
    }, ctx => storageStatus(ctx).migrated ? [
        ['variables'], ['LWB_RULES_V2'], [MIGRATION_KEY], ['extensions','LittleWhiteBox','stateCkptV2'], ['extensions','LittleWhiteBox','stateLogV2'],
    ] : [], ctx => { if (ctx?.chatMetadata === getContext()?.chatMetadata) sync(); });
    function sync() {
        if (disposed || projecting) return false;
        const ctx=getContext();
        if (!ctx?.chatMetadata || !storageStatus(ctx).migrated) return false;
        const lock = metadataWriteStatus(getContext);
        if (lock.busy || lock.dirty) return false;
        try {
            const errors = String(ctx.chatMetadata.variables?.LWB_STATE_ERRORS ?? '');
            if (errors && errors !== lastErrors) say('小白变量 2.0 反馈：'+errors);
            lastErrors = errors;
            const result = projectState2(ctx);
            if (!result.patches.length) return false;
            projecting = true;
            let release = () => {};
            try {
                release = acquireMetadataWrite(getContext, captureContext(getContext));
                // These are validated derived app views only. Never write native roots while replaying.
                setPatches(ctx.chatMetadata,result.patches);
                publishExternalMetadataChange(getContext,result.patches.map(p=>p.path));
                ctx.saveMetadataDebounced?.();
            } finally { projecting=false;release(); }
            say('已从小白变量 2.0 同步应用窗口；变量是当前剧情状态来源。');
            return true;
        } catch (error) { say('小白变量同步未完成：'+error.message); return false; }
    }
    async function migrate() {
        if (!available()) throw Error('请先启用小白 X 变量管理 2.0。');
        const ctx=getContext(), identity=chatIdentity(ctx), source=JSON.stringify(chatPath(ctx.chat));
        const result=migrateState2(ctx);
        if (!result.patches.length) {
            if (!result.migrated) throw Error(result.reason || '当前聊天尚不满足变量迁移条件。');
            sync(); return {changed:false,message:'当前聊天已迁移，已有变量保持原值。'};
        }
        operation.stage({label:'迁移剧情资料至小白变量 2.0',patches:result.patches,summary:['保留旧记录与迁移备份，建立当前楼层变量基线']});
        await operation.confirm();
        if (getContext()?.chatMetadata!==ctx.chatMetadata || chatIdentity(getContext())!==identity || JSON.stringify(chatPath(getContext().chat))!==source) throw Error('迁移已保存到原聊天，请重新打开当前聊天。');
        sync();say('当前聊天剧情资料已迁移到小白变量 2.0；旧记录已保留。');
        return {changed:true,message:lastMessage};
    }
    async function prepareGeneration() {
        if (!available()) throw Error('请先启用小白 X 变量管理 2.0，再生成剧情。');
        if (!storageStatus(getContext()).migrated) await migrate();
        sync();
        // Re-run validation even if sync reported an invalid projection.
        projectState2(getContext());
    }
    function collectReply(index) {
        const text=getContext()?.chat?.[index]?.mes??'';
        sync();
        const errors=getContext()?.chatMetadata?.variables?.LWB_STATE_ERRORS;
        const message=errors ? '小白变量 2.0 反馈：'+String(errors) : /<state>[\s\S]*<\/state>/.test(text) ? '已检测到 <state>；由小白变量 2.0 执行，Amin 不重复执行。' : '本轮回复没有原生 <state> 更新块。';
        say(message);return {outcome:'native',message};
    }
    const source=getContext()?.eventSource, events=getContext()?.eventTypes??getContext()?.event_types??{};
    for(const name of ['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_ENDED'])if(source?.on&&events[name]){
        const fn=()=>{sync();};source.on(events[name],fn);subscriptions.push([events[name],fn]);
    }
    const jq=host.jQuery??host.$;
    const nativeEvent='xiaobaix:variables:stateAtomsGenerated.aminState2';
    if(typeof jq==='function'&&document)jq(document).on(nativeEvent,sync);
    // LWB restoration has no stable public completion event in supported versions.
    // A cheap periodic reconciliation also covers variable-panel edits and delayed replay.
    if(interval>0){timer=setInterval(sync,interval);timer.unref?.();}
    return { sync,migrate,prepareGeneration,collectReply,status:()=>({...nativeState2Status(getContext()),available:available(),message:lastMessage||nativeState2Status(getContext()).message}),
        async retrySave(){return operation.retrySave();},
        destroy(){disposed=true;clearInterval(timer);removeExpansion();operation.dispose();for(const [event,fn]of subscriptions)(source.removeListener??source.off)?.call(source,event,fn);if(typeof jq==='function'&&document)jq(document).off(nativeEvent,sync);},
    };
}
export function initializeState2(getContext = context, options = {}) { return shared ??= createState2Runtime(getContext,options); }
export function getState2Runtime(){return shared;}
