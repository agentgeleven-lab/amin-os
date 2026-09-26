import { createStoryLibraryService } from '../shared/story-library-service.js';
import { getReference } from '../shared/story-message-refs.js';
import { performanceDiagnostics } from '../shared/performance-diagnostics.js';
import { createUpdateDiagnostics } from './update-diagnostics.js';
import { migrateState2, projectState2, manualState2Patches, ROOTS, MIGRATION_KEY, nativeState2Status as storageStatus, prepareState2ManualWrite as prepareManual } from './storage.js';
import { restoreNativeState2ToFloor } from './native-bridge.js';
import { isChatReady } from '../shared/chat-lifecycle.js';
import { createStoryStorage } from './story-storage.js';
import { createStoryFileStore } from '../shared/story-file-store.js';
import { createStoryStateGraph } from '../shared/story-state-graph.js';
import { registerChatSavePreparation, markChatIdsDirty, saveChatMetadata } from '../shared/chat-save.js';
import { createOperationService, registerOperationPatchExpansion, metadataWriteStatus, acquireMetadataWrite, captureContext, publishExternalMetadataChange, chatIdentity, chatPath } from '../shared/operations.js';
export function prepareState2ManualWrite(ctx, paths) {
    if (shared && storageStatus(ctx).migrated && !shared.ready(ctx)) throw Error('正在恢复当前聊天的楼层变量，请等待恢复完成。');
    return prepareManual(ctx, paths);
}
export function state2HistoryMode(ctx) {
    if (!ctx?.chatMetadata?.[MIGRATION_KEY]) return { managed: false, ready: true };
    const managed = storageStatus(ctx).migrated;
    return { managed, ready: !managed || !!shared?.ready(ctx) };
}

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
export function createState2Runtime(getContext = context, { report = () => {}, interval = 700, host = globalThis, document = globalThis.document, restoreNative = restoreNativeState2ToFloor, storyStorage } = {}) {
    let disposed = false, projecting = false, migrating = false, lastMessage = '', timer = null, lastErrors = null, restoreError = '';
    let activeMetadata = null, activeIdentity = null, restoring = false, restoreTask = null, restoreFailed = false, settled = false, epoch = 0, cached = null, eventTimer = null;
    const subscriptions = [], operation = createOperationService(getContext);
    const updates = createUpdateDiagnostics({roots:[...Object.values(ROOTS),'状态栏','势力资料']});
    let updateRound = null, updateTimer = null, updateOwner = null;
    function clearUpdates() { clearTimeout(updateTimer); updateRound = null; updateOwner = null; updates.clear(); }
    function scheduleUpdateRecord() {
        if (!updateRound?.ended || streaming()) return;
        clearTimeout(updateTimer);
        updateTimer = setTimeout(() => {
            const ctx = getContext(), round = updateRound;
            if (!round || disposed || streaming()) return;
            if (ctx?.chatMetadata !== round.metadata || chatIdentity(ctx) !== round.identity) { clearUpdates(); return; }
            const index = ctx.chat.length - 1, message = ctx.chat[index];
            if (!message || message.is_user || message.is_system) return;
            updateRound = null;
            updates.finish({variables:ctx.chatMetadata.variables,index,swipe:message.swipe_id??0,
                receivedState:/<state>[\s\S]*<\/state>/.test(message.mes??''),errors:ctx.chatMetadata.variables?.LWB_STATE_ERRORS??[],source:round.source});
            // Snapshot at this point in time; no <state> execution or metadata write.
            report(lastMessage);
        }, 60);
    }
    const library = createStoryLibraryService({ getHostWindow: () => host.window ?? host, getContext });
    const files = createStoryFileStore({ getHostWindow: () => host.window ?? host });
    const story = storyStorage ?? createStoryStorage(getContext, { graph: createStoryStateGraph(files), available: () => files.available(), host, document });
    let archiveTask = null, archiveAgain = false, observedNative = null, activeGeneration = null, generationBaseline = null;
    const streaming = () => { const ctx=getContext(),stream=ctx?.streamingProcessor; return !!stream && !stream.isFinished || !!activeGeneration && activeGeneration.metadata===ctx?.chatMetadata && activeGeneration.identity===chatIdentity(ctx); };
    function captureOptions(ctx) {
        const base=generationBaseline;
        if(!base||base.metadata!==ctx.chatMetadata||base.identity!==chatIdentity(ctx)||base.index!==ctx.chat.length-1
            ||base.prefix!==JSON.stringify(chatPath(ctx.chat.slice(0,base.index))))return {};
        return {expectedReference:base.reference};
    }
    const external = () => getContext()?.chatMetadata?.amin_os_story_storage_v2?.version === 2;
    const removeSavePreparation = registerChatSavePreparation(async ctx => {
        if (!external() || ctx.chatMetadata !== getContext()?.chatMetadata || restoring || streaming()) return;
        if (!ready(ctx)) throw Error('外置剧情状态尚未恢复，不能保存新的状态引用。' + (sameChat(ctx) && restoreError ? '原因：' + restoreError : '请在世界状态 → 联动更新查看变量恢复状态。'));
        const result = await story.capture(captureOptions(ctx));
        generationBaseline=null;
        if (result.changed) markChatIdsDirty(ctx);
    });
    const say = text => { if (text !== lastMessage) { lastMessage = text; report(text); } };
    const available = () => getContext()?.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0' && typeof host.LWB_StateV2?.applyText === 'function';
    const removeExpansion = registerOperationPatchExpansion((ctx, patches) => {
        if (projecting || !storageStatus(ctx).migrated) return patches;
        return combine(patches, manualState2Patches(ctx, patches).patches);
    }, (ctx, paths) => storageStatus(ctx).migrated && paths.length ? [
        ['variables'], ['LWB_RULES_V2'], [MIGRATION_KEY], ['extensions','LittleWhiteBox','stateCkptV2'], ['extensions','LittleWhiteBox','stateLogV2'],
    ] : [], ctx => {
        if (projecting || migrating || ctx?.chatMetadata !== getContext()?.chatMetadata) return;
        sync();
        if (storageStatus(ctx).migrated && !ready(ctx)) throw Error('当前聊天的楼层变量尚未恢复完成，请稍后重试。');
    });
    const sameChat = ctx => activeMetadata === ctx?.chatMetadata && activeIdentity === chatIdentity(ctx);
    function ready(ctx = getContext()) { return isChatReady(ctx) && (!storageStatus(ctx).migrated || sameChat(ctx) && settled && !restoring && !restoreFailed); }
    function signature(ctx) {
        const tail = ctx.chat?.at(-1), meta = ctx.chatMetadata;
        const wal = meta.extensions?.LittleWhiteBox?.stateLogV2?.floors?.[String((ctx.chat?.length ?? 0) - 1)];
        // Canonical native variables are strings. Comparing them directly avoids
        // serializing the entire live state again on every reconciliation tick.
        return [ctx.chat?.length, tail?.mes, tail?.swipe_id,
            ...Object.values(ROOTS).map(root => meta.variables?.[root]), meta.variables?.状态栏, meta.variables?.势力资料,
            wal?.signature, JSON.stringify(wal?.roots ?? [])].map(value => value && typeof value === 'object' ? JSON.stringify(value) : value);
    }
    const sameSignature = (left, right) => left && left.length === right.length && left.every((value, index) => value === right[index]);
    async function restoreChat() {
        const ctx = getContext();
        if (!isChatReady(ctx) || !ctx?.chatMetadata || !storageStatus(ctx).migrated || disposed) return;
        if (sameChat(ctx) && restoring) return restoreTask;
        if (!sameChat(ctx)) clearUpdates();
        activeMetadata = ctx.chatMetadata; activeIdentity = chatIdentity(ctx);
        settled = false; restoreFailed = false; restoreError = ''; cached = null;
        const lock = metadataWriteStatus(getContext);
        if (lock.busy || lock.dirty) return;
        restoring = true;
        const ticket = ++epoch;
        say('正在通过小白变量 2.0 恢复当前分支楼层…');
        restoreTask = (async () => {
            const measured = performanceDiagnostics.begin('restore'); let failed = false;
            let release = () => {};
            try {
                if (!available()) throw Error('请启用小白 X 变量管理 2.0。');
                projecting = true;
                try { release = acquireMetadataWrite(getContext, captureContext(getContext)); }
                finally { projecting = false; }
                if (external() && story.ensureIndex) {
                    const indexed = await story.ensureIndex();
                    if (indexed.changed) { markChatIdsDirty(ctx); await saveChatMetadata(ctx); }
                }
                const result = external()
                    ? await story.restoreFloor((ctx.chat?.length ?? 0) - 1)
                    : await restoreNative((ctx.chat?.length ?? 0) - 1, { context: getContext, host, document });
                if (disposed || ticket !== epoch || !sameChat(getContext())) return;
                if (!result?.restored || result.stale) throw Error('回放期间聊天或楼层已变化，请重试。');
                settled = true; restoring = false;
                if (external()) observedNative = signature(ctx);
                // Native replay owns variables. Notify observers only after it finishes.
                projecting = true;
                try { publishExternalMetadataChange(getContext, [['variables','状态栏'], ['variables','势力资料']]); }
                finally { projecting = false; }
            } catch (error) {
                failed = true;
                if (ticket === epoch && sameChat(getContext())) { restoreFailed = true; restoreError = error.message; say('楼层变量恢复未完成：' + error.message); }
            } finally {
                measured({failed});
                release();
                if (ticket === epoch) restoring = false;
            }
            if (ticket === epoch && settled && !restoreFailed) {
                sync();
                if (!lastMessage.startsWith('小白变量同步未完成')) say('已按当前分支末尾楼层恢复变量。');
            }
        })();
        return restoreTask;
    }
    async function archive() {
        if (!external() || !ready() || disposed || streaming()) return;
        if (archiveTask) { archiveAgain = true; return archiveTask; }
        const ctx = getContext();
        if (metadataWriteStatus(getContext).busy || metadataWriteStatus(getContext).dirty) return;
        const capturedSignature = signature(ctx);
        archiveTask = (async () => {
            let release = () => {};
            try {
                release = acquireMetadataWrite(getContext, captureContext(getContext));
                const result = await story.capture(captureOptions(ctx));
                generationBaseline=null;
                if (result.changed) { markChatIdsDirty(ctx); await saveChatMetadata(ctx); }
                observedNative = capturedSignature;
            } catch (error) {
                if (error?.code === 'INCOMPLETE_CANDIDATE') return;
                observedNative = capturedSignature;
                say('外置剧情状态保存未完成：' + error.message); return { error };
            }
            finally { release(); }
        })();
        try { return await archiveTask; } finally {
            archiveTask = null;
            if (archiveAgain) { archiveAgain = false; queueMicrotask(() => { if (!disposed) void archive(); }); }
        }
    }
    function sync() {
        if (disposed || projecting || migrating || streaming()) return false;
        const ctx=getContext();
        if (!isChatReady(ctx) || !ctx?.chatMetadata || !storageStatus(ctx).migrated) return false;
        if (!sameChat(ctx) || !settled && !restoring && !restoreFailed) { void restoreChat(); return false; }
        if (!ready(ctx)) return false;
        const lock = metadataWriteStatus(getContext);
        if (lock.busy || lock.dirty) return false;
        try {
            const errors = String(ctx.chatMetadata.variables?.LWB_STATE_ERRORS ?? '');
            if (errors && errors !== lastErrors) say('小白变量 2.0 反馈：'+errors);
            lastErrors = errors;
            const currentSignature = signature(ctx);
            if (sameSignature(cached, currentSignature)) return false;
            const result = projectState2(ctx);
            if (!result.patches.length) { cached = currentSignature; return false; }
            projecting = true;
            let release = () => {};
            try {
                release = acquireMetadataWrite(getContext, captureContext(getContext));
                // These are validated derived app views only. Never write native roots while replaying.
                setPatches(ctx.chatMetadata,result.patches);
                publishExternalMetadataChange(getContext,result.patches.map(p=>p.path));
                // Derived views are reconstructible from native variables. Reading
                // a chat must not schedule a delayed write into another chat.
            } finally { projecting=false;release(); }
            cached = currentSignature;
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
            if (!ready()) await restoreChat();
            if (!ready()) throw Error(lastMessage || '当前聊天的变量回放尚未完成。');
            sync(); return {changed:false,message:'当前聊天已迁移，已有变量保持原值。'};
        }
        operation.stage({label:'迁移剧情资料至小白变量 2.0',patches:result.patches,summary:['保留旧记录与迁移备份，建立当前楼层变量基线']});
        migrating = true;
        try { await operation.confirm(); }
        finally {
            migrating = false;
            if (getContext()?.chatMetadata === ctx.chatMetadata && storageStatus(ctx).migrated) {
                activeMetadata = ctx.chatMetadata; activeIdentity = chatIdentity(ctx); settled = true; cached = null;
            }
        }
        if (getContext()?.chatMetadata!==ctx.chatMetadata || chatIdentity(getContext())!==identity || JSON.stringify(chatPath(getContext().chat))!==source) throw Error('迁移已保存到原聊天，请重新打开当前聊天。');
        activeMetadata = ctx.chatMetadata; activeIdentity = chatIdentity(ctx); settled = true; cached = null;
        if (ctx.chat.length <= 1 && story.status().available && !external()) {
            await story.enable();
            await story.ensureIndex?.();
            markChatIdsDirty(ctx);
            await saveChatMetadata(ctx);
        }
        sync();say('当前聊天剧情资料已迁移到小白变量 2.0；旧记录已保留。');
        return {changed:true,message:lastMessage};
    }
    async function prepareGeneration(type) {
        if (!available()) throw Error('请先启用小白 X 变量管理 2.0，再生成剧情。');
        if (!storageStatus(getContext()).migrated) await migrate();
        if (external() && ['swipe', 'regenerate'].includes(type) && !getContext()?.chat?.at(-1)?.is_user) {
            const ctx = getContext(), release = acquireMetadataWrite(getContext, captureContext(getContext));
            restoring = true;
            try {
                await story.restoreBeforeCandidate(type);
                activeMetadata = ctx.chatMetadata; activeIdentity = chatIdentity(ctx);
                settled = true; restoreFailed = false; cached = null;
                observedNative = signature(ctx);
            } finally { restoring = false; release(); }
        } else if (!ready()) await restoreChat();
        if (!ready()) throw Error('当前分支变量恢复失败，请先处理联动更新页的错误提示。');
        sync();
        // Re-run validation even if sync reported an invalid projection.
        projectState2(getContext());
        if (external() && !['swipe','regenerate'].includes(type)) {
            const result = await archive();
            if (result?.error) throw result.error;
        }
        if (['normal','swipe','regenerate','continue'].includes(type)) {
            const ctx = getContext(); clearTimeout(updateTimer);
            updateRound = { metadata:ctx.chatMetadata, identity:chatIdentity(ctx), source:type };
            updateOwner = { metadata:ctx.chatMetadata, identity:chatIdentity(ctx) };
            updates.begin({variables:ctx.chatMetadata.variables,source:type});
        }
    }
    function collectReply(index) {
        const text=getContext()?.chat?.[index]?.mes??'';
        sync();
        const errors=getContext()?.chatMetadata?.variables?.LWB_STATE_ERRORS;
        const message=errors ? '小白变量 2.0 反馈：'+String(errors) : /<state>[\s\S]*<\/state>/.test(text) ? '已检测到 <state>；由小白变量 2.0 执行，Amin 不重复执行。' : '本轮回复没有原生 <state> 更新块。';
        if (updateRound) updateRound.ended=true;
        scheduleUpdateRecord();say(message);return {outcome:'native',message};
    }
    const source=getContext()?.eventSource, events=getContext()?.eventTypes??getContext()?.event_types??{};
    for(const name of ['CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_ENDED','GENERATION_STOPPED'])if(source?.on&&events[name]){
        const fn=(index)=>{
            cached = null;
            if (name === 'CHAT_CHANGED') {clearUpdates();activeGeneration=null;generationBaseline=null;return restoreChat();}
            if (['GENERATION_ENDED','GENERATION_STOPPED'].includes(name)) activeGeneration=null;
            if (name === 'GENERATION_ENDED') { if(updateRound)updateRound.ended=true; scheduleUpdateRecord(); }
            if (name === 'GENERATION_STOPPED') { clearTimeout(updateTimer); updateRound=null; }
            if (streaming() && ['MESSAGE_UPDATED','MESSAGE_RECEIVED'].includes(name)) return;
            // TT emits MESSAGE_SWIPED before Generate('swipe') when selecting
            // the empty slot after the saved candidates. It has no state yet.
            // Only this exact tail-slot transition can use the previous floor;
            // existing/edited candidates still require their own valid refs.
            const ctx = getContext(), tail = ctx.chat?.at(-1);
            if (external() && name === 'MESSAGE_SWIPED' && index === ctx.chat.length - 1
                && !tail?.is_user && !tail?.is_system && Array.isArray(tail?.swipes)
                && tail.swipes.length > 0 && tail.swipe_id === tail.swipes.length) {
                const metadata = ctx.chatMetadata, identity = chatIdentity(ctx);
                return prepareGeneration('swipe').catch(error => {
                    if (getContext()?.chatMetadata !== metadata || chatIdentity(getContext()) !== identity) return;
                    restoreFailed = true; restoreError = error.message;
                    say('上一楼剧情状态恢复未完成：' + error.message);
                });
            }
            if (external() && ['MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_UPDATED'].includes(name)
                && !(name==='MESSAGE_UPDATED' && index===ctx.chat.length-1 && Object.hasOwn(captureOptions(ctx),'expectedReference'))) {
                settled = false; restoreFailed = false;
                return restoreChat();
            }
            clearTimeout(eventTimer);eventTimer=setTimeout(() => { sync(); void archive(); },25);
        };source.on(events[name],fn);subscriptions.push([events[name],fn]);
    }
    if (source?.on && events.GENERATION_AFTER_COMMANDS) {
        const gate = async (type, _options, dryRun) => {
            if (dryRun || !external()) return;
            try {
                await prepareGeneration(type);
                if(['normal','swipe','regenerate','continue'].includes(type)){
                    const ctx=getContext();activeGeneration={metadata:ctx.chatMetadata,identity:chatIdentity(ctx)};
                    generationBaseline=null;
                    if(['continue','regenerate'].includes(type)&&!ctx.chat.at(-1)?.is_user){
                        const index=ctx.chat.length-1,reference=story.status().indexed ? null : getReference(ctx.chat[index]);
                        generationBaseline={...activeGeneration,index,reference,prefix:JSON.stringify(chatPath(ctx.chat.slice(0,index)))};
                    }
                }
            }
            catch (error) { activeGeneration=null;generationBaseline=null;restoreFailed = true;restoreError=error.message;say('剧情状态未就绪，已阻止生成：' + error.message); }
        };
        source.on(events.GENERATION_AFTER_COMMANDS, gate); subscriptions.push([events.GENERATION_AFTER_COMMANDS, gate]);
    }
    const jq=host.jQuery??host.$;
    const nativeEvent='xiaobaix:variables:stateAtomsGenerated.aminState2';
    const nativeChanged = () => { sync(); void archive(); scheduleUpdateRecord(); };
    if(typeof jq==='function'&&document)jq(document).on(nativeEvent,nativeChanged);
    // LWB restoration has no stable public completion event in supported versions.
    // A cheap periodic reconciliation also covers variable-panel edits and delayed replay.
    function reconcile() {
        sync();
        if (updateRound?.ended) scheduleUpdateRecord();
        // Some LWB versions signal before applying variables. Reconcile a late
        // native write once; unchanged reads and unchanged failures never save.
        if (external() && ready() && !sameSignature(observedNative, signature(getContext()))) return archive();
    }
    if(interval>0){timer=setInterval(reconcile,interval);timer.unref?.();}
    return { sync,reconcile,migrate,prepareGeneration,collectReply,restoreChat,ready,status:()=>({...nativeState2Status(getContext()),available:available(),ready:ready(),restoring:sameChat(getContext())&&restoring,restoreError:sameChat(getContext())?restoreError:'',message:lastMessage||nativeState2Status(getContext()).message}),
        updateDiagnostics:()=>updateOwner?.metadata===getContext()?.chatMetadata&&updateOwner.identity===chatIdentity(getContext())?updates.records():[],clearUpdateDiagnostics(){clearUpdates();report(lastMessage);},
        inspectStoryIndex:()=>story.inspectIndex(),
        scanStoryLibrary:options=>library.scan(options),
        exportStoryLibraryCandidates:(report,options)=>library.exportCandidates(report,options),
        inspectStoryReferences: () => story.inspectReferences(),
        async repairStoryReferences(plan) {
            if (streaming()) throw Error('请等待生成结束再修复引用。');
            const ctx = getContext(), release = acquireMetadataWrite(getContext, captureContext(getContext));
            restoring = true;
            try {
                const result = await story.repairReferences(plan);
                try { if (result.changed) { markChatIdsDirty(ctx); await saveChatMetadata(ctx); } }
                catch(error){result.rollback();throw error;}
            } finally { restoring = false; release(); }
            await restoreChat();
            if (!ready()) throw Error(restoreError || lastMessage);
            return { message: '已重新关联所列楼层的原有剧情存档，并恢复当前分支。' };
        },
        readStoryFloor: index => story.readFloor(index), storyStatus: () => story.status(),
        async archiveStory() {
            if (streaming()) throw Error('请等待生成结束再保存剧情存档。');
            const ctx = getContext(), result = await story.capture(captureOptions(ctx));
            generationBaseline = null;
            if (result.changed) markChatIdsDirty(ctx);
            return result;
        },
        readStoryState: id => story.readState(id),
        exportStory: () => story.exportStory(), importStory: bundle => story.importStory(bundle),
        async inspectStoryStorage() {
            const bundle = await story.exportStory(), nodes = Object.values(bundle.graph.nodes);
            const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
            const ctx = getContext();
            return { bytes: nodes.reduce((sum, node) => sum + bytes(node), 0), records: nodes.length,
                checkpointCount: nodes.filter(node => node.kind === 'snapshot').length,
                deltaCount: nodes.filter(node => node.kind === 'delta').length,
                referenceBytes: (ctx.chat ?? []).reduce((sum, message) => sum + (message.extra?.amin_story_v2 ? bytes(message.extra.amin_story_v2) : 0)
                    + (message.amin_story_message_id ? bytes({amin_story_message_id:message.amin_story_message_id}) : 0)
                    + (message.extra?.amin_story_candidate_id ? bytes({amin_story_candidate_id:message.extra.amin_story_candidate_id}) : 0)
                    + (message.swipe_info ?? []).reduce((n, swipe) => n + (swipe?.extra?.amin_story_v2 ? bytes(swipe.extra.amin_story_v2) : 0)
                        + (swipe?.extra?.amin_story_candidate_id ? bytes({amin_story_candidate_id:swipe.extra.amin_story_candidate_id}) : 0), 0), 0) };
        },
        async enableStoryStorage() {
            if (!storageStatus(getContext()).migrated) await migrate();
            if (!ready()) await restoreChat();
            if (!ready()) throw Error('当前变量尚未恢复，不能启用外置存储。');
            const ctx = getContext(), release = acquireMetadataWrite(getContext, captureContext(getContext));
            try { const result = await story.enable(); await story.ensureIndex?.(); markChatIdsDirty(ctx); await saveChatMetadata(ctx); cached = null; return result; }
            finally { release(); sync(); }
        },
        async retrySave(){return operation.retrySave();},
        destroy(){disposed=true;library.dispose();epoch++;clearUpdates();clearInterval(timer);clearTimeout(eventTimer);removeSavePreparation();removeExpansion();operation.dispose();for(const [event,fn]of subscriptions)(source.removeListener??source.off)?.call(source,event,fn);if(typeof jq==='function'&&document)jq(document).off(nativeEvent,nativeChanged);},
    };
}
export function initializeState2(getContext = context, options = {}) { return shared ??= createState2Runtime(getContext,options); }
export function getState2Runtime(){return shared;}
