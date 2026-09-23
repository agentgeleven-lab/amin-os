import { nativeState2Status, getState2Runtime } from '../state2/runtime.js';
import { uuid } from '../../uuid.js';
import { createOperationService, subscribeStateChanges, chatIdentity, chatPath } from '../shared/operations.js';
import { checkpointState } from '../status/state-checkpoint.js';
import { adapters as allAdapters } from './registry.js';
import { KEY, MODULES, readLinkageState, readLinkageSettings, validateLinkageState, modulePolicy, moduleAvailable, mayWrite, plain, validateJSON } from './policy.js';
import { parseUpdate, hasUpdate } from './protocol.js';
import { buildUnifiedPrompt, buildDataPrompt, buildUpdateRules } from './prompt.js';
import { buildReferenceIndex } from './references.js';

const clone = value => structuredClone(value), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const checkpointPath = ['extensions','LittleWhiteBox','stateCkptV2'];
const checkpointDependencies = [['variables'], ['LWB_RULES_V2'], ['extensions','LittleWhiteBox']];
// These archives are derived from canonical state and are never read by the
// reference index or a model-facing projection. Host observers may append the
// current floor asynchronously. Guard them only when an adapter actually writes
// them; operation.stage automatically adds every patch path to its save token.
const derivedHistories = new Set(['world_status_hud_history_v1', 'amin_os_organizations_history_v1', 'dynamicMapPositionHistoryV1']);
function valueAt(object, path) {
    for (const key of path) { if (!object || typeof object !== 'object' || !own(object, key)) return { exists: false }; object = object[key]; }
    return { exists: true, value: object };
}
function applyPatch(metadata, patch) {
    if (!plain(patch) || !Array.isArray(patch.path) || !patch.path.length || patch.path.some(k => typeof k !== 'string' || !k || ['__proto__','prototype','constructor'].includes(k))) throw Error('应用适配器返回无效的写入路径。');
    if (patch.remove !== true) validateJSON(patch.value);
    let parent = metadata;
    for (const key of patch.path.slice(0, -1)) { if (!own(parent, key)) parent[key] = {}; if (!plain(parent[key])) throw Error('更新路径上级不是对象。'); parent = parent[key]; }
    if (patch.remove === true) delete parent[patch.path.at(-1)]; else parent[patch.path.at(-1)] = clone(patch.value);
}
function pathModule(path) {
    if (path[0] === 'variables') return path[1] === '状态栏' ? 'status' : path[1] === '势力资料' ? 'organizations' : null;
    if (path[0] === 'world_status_hud_history_v1') return 'status';
    if (['amin_os_organizations_v1','amin_os_organizations_history_v1'].includes(path[0])) return 'organizations';
    if (path[0] === 'dynamicMapPositionHistoryV1') return 'map';
    return Object.keys(MODULES).find(id => MODULES[id][1] === path[0]) ?? null;
}
const sourceFor = (ctx, index = (ctx.chat?.length ?? 0) - 1) => ({ identity: chatIdentity(ctx), path: chatPath(ctx.chat), index, swipe: ctx.chat?.[index]?.swipe_id ?? 0, text: ctx.chat?.[index]?.mes ?? '' });
const sourceEqual = (a,b) => a.identity === b.identity && a.index === b.index && a.swipe === b.swipe && a.text === b.text && same(a.path,b.path);

export function createLinkageService(getContext = () => globalThis.SillyTavern?.getContext?.(), { adapters = allAdapters, createId = uuid, now = () => new Date().toISOString(), buildPrompt = buildUnifiedPrompt, manualModules = null } = {}) {
    if (manualModules !== null && (!Array.isArray(manualModules) || !manualModules.length || manualModules.some(id => !['characters','inventory','relationships','scene','journal'].includes(id)) || new Set(manualModules).size !== manualModules.length)) throw Error('手动生成范围无效。');
    const manualScope = manualModules === null ? null : new Set(manualModules);
    const canWrite = (ctx, id) => manualScope ? manualScope.has(id) : mayWrite(ctx,id);
    const batchLabel = manualScope ? 'AI 资料生成' : '跨应用剧情更新';
    const operation = createOperationService(getContext), listeners = new Set(), candidates = new Map();
    const paths = [...new Map([[KEY], ...adapters.flatMap(a => a.paths).filter(path => !derivedHistories.has(path[0]))].map(path => [JSON.stringify(path), path])).values()];
    let pending = null, generation = null, message = '', hostMessage = '', disposed = false;
    const notify = () => { for (const callback of [...listeners]) { try { callback(); } catch { /* A view cannot interrupt a commit. */ } } };
    const context = () => { if (disposed) throw Error('联动更新服务已关闭。'); const ctx = getContext(); if (!ctx?.chatMetadata || (ctx.getCurrentChatId?.() ?? ctx.chatId) == null) throw Error('请先打开聊天。'); return ctx; };
    const rawData = ctx => Object.fromEntries(adapters.map(a => [a.id, a.read(ctx)]));
    function allowedPatch(ctx, patch) {
        const id = pathModule(patch.path);
        if (!id || !canWrite(ctx,id)) throw Error(`本次操作没有修改 ${id ? MODULES[id][0] : patch.path.join('.')} 的权限。`);
        if (patch.path[0] === 'variables' && patch.path.length < 2) throw Error('不能整体替换聊天变量。');
        if (patch.path[0] === 'amin_os_organizations_v1' && !['locks','assessment','backups'].includes(patch.path[1])) throw Error('不能通过剧情更新修改势力应用设置。');
    }
    function ensureGeneration(candidate) {
        const ctx = context(), expected = candidate.basis;
        if (ctx.chatMetadata !== expected.metadata || chatIdentity(ctx) !== expected.identity || !same(chatPath(ctx.chat), candidate.source.path)) throw Error('更新来源的聊天、正文或候选已变化，请重新生成建议。');
        if (!same(rawData(ctx), expected.data) || !same(readLinkageState(ctx), expected.settings) || buildPrompt(ctx) !== expected.prompt) throw Error('生成期间关联资料或联动规则已变化，本次建议已过期。');
        return ctx;
    }
    function stage(raw, options = {}) {
        const ctx = options.candidate ? ensureGeneration(options.candidate) : context();
        const settings = readLinkageState(ctx);
        if (!settings.enabled && !manualScope) throw Error('请先启用统一联动更新。');
        const parsed = parseUpdate(raw);
        if (!parsed.changes.length) throw Error('本次没有需要更新的内容。');
        const source = options.candidate?.source ?? sourceFor(ctx);
        if (settings.applied.some(record => !record.archived && sourceEqual(record.source, source) && (options.candidate || same(record.changes, parsed.changes)))) throw Error('这次来源的更新已经应用，不会重复执行。');
        let token = operation.capture(paths);
        const operationId = createId(), at = now(), sandbox = { ...ctx, chatMetadata: clone(ctx.chatMetadata) };
        const touched = [], descriptions = [], changes = [], beforeData = rawData(sandbox);
        for (const [index, change] of parsed.changes.entries()) {
            if (!canWrite(ctx,change.module)) throw Error(`${MODULES[change.module][0]} 未在本次操作的更新范围内。`);
            const adapter = adapters.find(a => a.id === change.module);
            if (!adapter?.apply) throw Error('这个模块目前只支持读取。');
            const before = clone(adapter.read(sandbox)), original = JSON.stringify(sandbox.chatMetadata);
            const result = adapter.apply(sandbox, clone(change), { operationId: `${operationId}-${index}`, now: at });
            if (JSON.stringify(sandbox.chatMetadata) !== original) throw Error('应用适配器直接修改了资料，本次操作已拒绝。');
            if (!plain(result) || !Array.isArray(result.patches)) throw Error('应用适配器没有返回有效变更。');
            for (const patch of result.patches) { allowedPatch(ctx,patch); applyPatch(sandbox.chatMetadata,patch); touched.push(patch.path); }
            descriptions.push(String(result.summary ?? change.reason));
            changes.push({ ...change, label: adapter.label, before, after: clone(adapter.read(sandbox)) });
        }
        const afterData = rawData(sandbox); // Validate every module before the first live mutation.
        const beforeRefs = buildReferenceIndex(beforeData,settings.links), afterRefs = buildReferenceIndex(afterData,settings.links);
        const referenceKey = item => JSON.stringify([item.from,item.to]);
        const priorMissing = new Set(beforeRefs.unresolved.map(referenceKey));
        const newMissing = afterRefs.unresolved.filter(item => !priorMissing.has(referenceKey(item)));
        if (newMissing.length) throw Error('这批更新会产生新的无效引用：' + newMissing.map(item => `${item.from} → ${item.to}`).join('；'));
        if (touched.some(path => path[0] === 'variables')) {
            const checkpointCtx = { ...sandbox, saveMetadataDebounced() {} };
            if (checkpointState(checkpointCtx)) {
                touched.push(checkpointPath);
                // State 2.0 checkpoints include every variable and rule. Protect
                // those wider inputs only when this batch actually creates one.
                token = operation.capture([...paths, ...checkpointDependencies]);
            }
        }
        const nextSettings = clone(settings);
        nextSettings.applied.push({ id: operationId, at, source: clone(source), changes: parsed.changes });
        sandbox.chatMetadata[KEY] = validateLinkageState(nextSettings); touched.push([KEY]);
        const minimal = [...new Map(touched.map(path => [JSON.stringify(path),path])).values()].filter((path, _, all) => !all.some(other => other.length < path.length && other.every((part,i) => part === path[i])));
        const patches = minimal.flatMap(path => {
            const before = valueAt(ctx.chatMetadata,path), after = valueAt(sandbox.chatMetadata,path);
            return same(before,after) ? [] : [{ path, ...(after.exists ? { value: after.value } : { remove:true }) }];
        });
        operation.stage({ label:batchLabel, patches, summary:descriptions },token);
        pending = { label:batchLabel, changes, summary:descriptions, warnings:afterRefs.unresolved.length ? ['已有未解析引用保持原样，请在关联目录检查。'] : [], operationId, candidateId:options.candidate?.id };
        message = '全部变更已校验；确认后作为同一次操作保存。'; notify(); return preview();
    }
    function preview() { if (!operation.preview()) return null; return clone(pending ?? { label:'保存联动设置', changes:[], summary:[], warnings:[] }); }
    async function confirm() {
        const candidateId = pending?.candidateId;
        try { const result = await operation.confirm(); pending = null; if (candidateId) candidates.delete(candidateId); message = '关联更新已保存。'; return result; }
        catch (error) { message = error.message; throw error; }
        finally { notify(); }
    }
    async function saveSettings(input) {
        if (manualScope) throw Error('手动资料生成不能修改统一联动设置。');
        const ctx = context(), token = operation.capture([[KEY]]), previous = readLinkageState(ctx);
        const next = validateLinkageState({ ...clone(input), version:1, applied:previous.applied });
        operation.stage({ label:'保存联动设置', patches:[{path:[KEY],value:next}] },token); pending = null;
        try { const result = await operation.confirm(); message = '联动设置已保存。'; generation = null; candidates.clear(); return result; }
        finally { notify(); }
    }
    function captureGeneration(type = 'normal', source = {}) {
        generation = null;
        if (manualScope) return false;
        if (!['normal','regenerate','swipe'].includes(type)) return false;
        const ctx = context(); if (!readLinkageState(ctx).enabled || operation.busy() || operation.dirty()) return false;
        const chat = [...(ctx.chat ?? [])];
        if (['regenerate','swipe'].includes(type) && chat.length && !chat.at(-1).is_user && !chat.at(-1).is_system
            && (!Object.hasOwn(source, 'excludedReply') || chat.at(-1) === source.excludedReply)) chat.pop();
        const effective = { ...ctx, chat };
        generation = { id:createId(), metadata:ctx.chatMetadata, identity:chatIdentity(ctx), path:chatPath(chat), data:clone(rawData(effective)), settings:readLinkageState(ctx), prompt:buildPrompt(effective) };
        return true;
    }
    async function collectReply(index) {
        const basis = generation; generation = null;
        if (!basis) return null;
        const ctx = context(), chat = ctx.chat ?? [], reply = chat[index];
        if (ctx.chatMetadata !== basis.metadata || chatIdentity(ctx) !== basis.identity || !Number.isInteger(index) || index !== chat.length - 1 || index !== basis.path.length || !same(chatPath(chat.slice(0,index)),basis.path) || !reply || reply.is_user || reply.is_system) return null;
        if (!hasUpdate(reply.mes)) {
            message = '本轮回复未返回 amin_update 更新块；请检查模型输出及消息原文正则。'; notify();
            return { outcome:'missing' };
        }
        const candidate = { id:basis.id, source:sourceFor(ctx,index), text:reply.mes, basis };
        try {
            const parsed = parseUpdate(reply.mes);
            if (!parsed.changes.length) {
                ensureGeneration(candidate);
                message = '模型已返回更新块：本轮无可提交的变化，未修改资料。'; notify();
                return { outcome:'empty' };
            }
        } catch (error) {
            message = '更新块无效或已过期：' + error.message; notify();
            return { outcome:'invalid' };
        }
        if (readLinkageState(ctx).applied.some(record=>!record.archived && sourceEqual(record.source,candidate.source))) return null;
        candidates.set(candidate.id,candidate); message='收到跨应用更新建议，请查看预览。'; notify();
        if (readLinkageState(ctx).mode === 'auto') {
            try { stage(candidate.text,{candidate}); await confirm(); }
            catch (error) { message='自动更新未完成：'+error.message; notify(); }
        }
        return { id:candidate.id, source:clone(candidate.source), text:candidate.text };
    }
    const unsubscribe = operation.subscribe(notify);
    const unsubscribeState = subscribeStateChanges((_event, metadata) => { if (metadata === getContext()?.chatMetadata) notify(); });
    return {
        nativeState2Status:()=>nativeState2Status(context()),
        migrateState2:()=>{const runtime=getState2Runtime();if(!runtime)throw Error('变量 2.0 运行时尚未初始化，请刷新插件。');return runtime.migrate();},
        settings:()=>readLinkageSettings(context()), saveSettings,
        modules:()=>{const ctx=context();return adapters.map(a=>({id:a.id,label:a.label,available:moduleAvailable(ctx,a.id),...modulePolicy(ctx,a.id)}));},
        prompt:()=>buildUpdateRules(context()), dataPrompt:()=>buildDataPrompt(context()), references:()=>buildReferenceIndex(rawData(context()),readLinkageState(context()).links),
        saveLinks(links){
            const ctx=context(),known=new Set(buildReferenceIndex(rawData(ctx)).entities.map(item=>item.id)),old=readLinkageState(ctx).links;
            for(const link of links)if(!old.some(value=>same(value,link))&&(!known.has(link.from)||!known.has(link.to)))throw Error('新的手动关联必须选择当前存在的条目。');
            return saveSettings({...readLinkageSettings(ctx),links:clone(links)});
        },
        stage, preview, confirm, discard(){operation.discard();pending=null;message='已取消预览。';notify();},
        async retrySave(){try{return await operation.retrySave();}finally{message=operation.status();notify();}},
        busy:operation.busy, dirty:operation.dirty, status:()=>[message||operation.status(),hostMessage].filter(Boolean).join('\n'), context,
        reportHost(value){hostMessage=String(value??'');notify();},
        suggestions:()=>[...candidates.values()].filter(c=>c.source.identity===chatIdentity(getContext())).map(({id,source,text})=>({id,source:clone(source),text})),
        stageSuggestion(id){const candidate=candidates.get(id);if(!candidate)throw Error('更新建议已失效。');return stage(candidate.text,{candidate});},
        captureGeneration, collectReply, cancelGeneration(){generation=null;},
        subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);},
        dispose(){disposed=true;generation=null;candidates.clear();unsubscribe();unsubscribeState();operation.dispose();listeners.clear();},
    };
}
let shared;
export const getSharedService = () => shared ??= createLinkageService();
