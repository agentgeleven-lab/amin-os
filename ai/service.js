import {resolveHostConnection} from './host-connection.js';
import {waitForSignal} from '../apps/map/src/core/generation-job.js';
import {currentPrompt} from '../apps/effects/model.js';
import { createApiSettings, createApiProfiles, generateMapText } from '../apps/map/src/adapters/generation.js';
import { createPresetLibrary, compilePreset } from '../apps/map/src/core/generation-presets.js';

let shared;
export const getAI = () => shared;
export function initializeAI(storage, namespace, options) {
    return shared ??= createAI(storage, namespace, options);
}
export function createAI(storage, namespace, {resolveConnection=resolveHostConnection, fetchImpl} = {}) {
    const connections=new WeakMap();
    const scope = `amin-os:${namespace}`;
    const settings = createApiSettings(storage, scope);
    const profiles = createApiProfiles(storage, scope);
    const presets = createPresetLibrary(storage, scope);
    const initialPreset=presets.list().find(p=>p.id==='default');
    if(initialPreset?.name==='默认地图预设')presets.save({...initialPreset,name:'默认共享预设'});
    const selectionKey = `amin-os.ai-preset:${namespace}`;
    const listeners = new Set(), tasks = [], previews = new Map();
    let selected = storage.getItem(selectionKey) || presets.list()[0].id;
    const notify = () => listeners.forEach(f => f());
    return {
        settings, profiles, presets,
        selected: () => selected,
        select(id) { if (!presets.list().some(p => p.id === id)) throw Error('预设不存在'); storage.setItem(selectionKey, id); selected = id; notify(); },
        capture() { return structuredClone({ config: settings.snapshot(), preset: presets.list().find(p => p.id === selected) ?? presets.list()[0] }); },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        tasks: () => tasks.map(({controller, ...rest}) => ({...rest})),
        previews: () => [...previews].map(([app, text]) => ({app, text})),
        cancel(id) { tasks.find(t => t.id === id)?.controller.abort(new Error('已从 AI 设置取消任务')); },
        async generate(app, ctx, request, { signal, snapshot, data, includeEffects = true } = {}) {
            const effectPrompt=includeEffects?currentPrompt(ctx):'';
            const captured = snapshot ?? this.capture();
            if(!captured.preset.blocks.some(b=>b.type==='request'&&b.enabled))throw Error('共享预设必须启用“本次要求”块，请在 AI 设置中恢复。');
            const controller = new AbortController();
            const abort = () => controller.abort(signal?.reason);
            if (signal?.aborted) abort();
            signal?.addEventListener('abort', abort, {once:true});
            const task = {id:crypto.randomUUID(), app, state:'等待模型 / 排队中', controller};
            const messages = [{role:'system',content:request.systemPrompt}, ...compilePreset(captured.preset, data ?? {request:request.prompt})];
            if(effectPrompt)messages.push({role:'system',content:effectPrompt});
            // Keep each application's output protocol outside editable preset blocks.
            messages.push({role:'system',content:request.systemPrompt});
            previews.set(app, messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n'));
            tasks.push(task); while(tasks.length > 40 && ['完成','已取消','失败'].includes(tasks[0].state)) tasks.shift(); notify();
            try {
                if(!connections.has(captured))connections.set(captured,Promise.resolve().then(()=>resolveConnection(captured.config,ctx)));
                const timer=setTimeout(()=>controller.abort(new Error('读取 API 配置超时，未应用生成结果')),captured.config.timeoutSeconds*1000);
                let connection;
                try {connection=await waitForSignal(()=>connections.get(captured),controller.signal);}finally{clearTimeout(timer);}
                const text = await generateMapText(ctx, connection, {...request, messages, responseLength:captured.config.maxTokens}, {signal:controller.signal, targetKey:scope, fetchImpl});
                task.state = '完成'; return text;
            } catch(error) { task.state = controller.signal.aborted ? '已取消' : '失败'; throw error; }
            finally { signal?.removeEventListener('abort', abort); notify(); }
        },
        importLegacy() {
            const old = createApiSettings(storage, namespace).snapshot();
            if(old.enabled || old.baseUrl) profiles.save('legacy-map', '原地图 API', old);
            const oldProfiles = createApiProfiles(storage, namespace);
            for(const p of oldProfiles.list()) profiles.save(`legacy-${p.id}`, `原地图 · ${p.name}`, oldProfiles.get(p.id));
            for(const p of createPresetLibrary(storage, namespace).list()) presets.save({...p,id:`legacy-${p.id}`,name:`原地图 · ${p.name}`});
            const status = globalThis.SillyTavern?.getContext?.().extensionSettings?.world_status_hud_v1;
            if(status?.baseUrl && status?.model) profiles.save('legacy-status','原状态栏 API',{...old,enabled:true,baseUrl:status.baseUrl,model:status.model,maxTokens:status.maxTokens||4096,apiKey:'',rememberKey:false});
            notify();
        },
    };
}
