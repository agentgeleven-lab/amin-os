import { createStoryLibraryHost } from './story-library-host.js';
import { createStoryLibraryFileStore } from './story-library-files.js';
import { scanStoryLibrary } from './story-library-scan.js';
import { sha256Hex } from '../tts/source-hash.js';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const check = signal => { if(signal.aborted)throw Object.assign(Error('全库检查已取消。'),{name:'AbortError'}); };

/** Session-only inspection. No delete capability is exposed without a host-wide barrier. */
export function createStoryLibraryService({getHostWindow=()=>globalThis.window,getContext,hostAdapter,store,scan=scanStoryLibrary}={}) {
    const host=hostAdapter ?? createStoryLibraryHost({getHostWindow,getContext});
    const files=store ?? createStoryLibraryFileStore({getHostWindow});
    let pending=null, disposed=false, lastReport=null;
    async function run(options,work){
        if(disposed)throw Error('存储检查已关闭。');
        if(pending)throw Error('全库检查正在进行，请先完成或取消。');
        const controller=new AbortController(), abort=()=>controller.abort();pending=controller;
        if(options.signal?.aborted)controller.abort();
        options.signal?.addEventListener('abort',abort,{once:true});
        try{check(controller.signal);return await work({...options,signal:controller.signal});}
        finally{options.signal?.removeEventListener('abort',abort);pending=null;}
    }
    async function inspect(options){
        const result=await scan({census:host.census,store:files,concurrency:1,signal:options.signal,onProgress:options.onProgress});check(options.signal);
        const capability=host.capabilities();
        return {...result,scope:capability.scope,capabilities:capability,deletionAuthorized:false,
            cleanupBlockedReason: [result.cleanupBlockedReason,capability.reason || '尚未建立覆盖聊天写入和同步的全局维护锁，永久删除不可用。'].filter(Boolean).join(' ')};
    }
    return {
        scan(options={}){return run(options,async settings=>{lastReport=await inspect(settings);return structuredClone(lastReport);});},
        exportCandidates(report,options={}){return run(options,async settings=>{
            if(!lastReport || !report || report.fingerprint!==lastReport.fingerprint)throw Error('请先在本次页面完成扫描。');
            const expected=lastReport, fresh=await inspect(settings);
            if(fresh.fingerprint!==expected.fingerprint) {lastReport=fresh;throw Error('文件或聊天引用已变化，请重新扫描并查看预览。');}
            const observed=fresh.observedUnreferenced ?? fresh.candidates ?? [];
            if(!observed.length)throw Error('本次没有可导出的候选文件。');
            const records={};let total=0;
            for(const item of observed){check(settings.signal);const value=await files.get(item.id);check(settings.signal);
                if(await sha256Hex(JSON.stringify(canonical(value)))!==item.fingerprint)throw Error('候选文件内容已变化，请重新扫描。');
                total+=new TextEncoder().encode(JSON.stringify(value)).length;if(total>64*1024*1024)throw Error('候选备份超过 64 MiB，请分批处理；未删除任何文件。');
                records[item.id]=value;
                settings.onProgress?.({phase:'export',completed:Object.keys(records).length,total:observed.length});
                await new Promise(resolve=>setTimeout(resolve,0));
            }
            check(settings.signal);
            return {format:'amin-os-story-library-archive',version:1,createdAt:new Date().toISOString(),scope:fresh.scope,
                scanFingerprint:fresh.fingerprint,complete:fresh.complete,bytes:total,
                note:'当前可枚举范围内未发现引用的原始文件备份；不证明文件可删除。未修改聊天或扩展存储。此文件不是单聊天导入包。',records};
        });},
        dispose(){disposed=true;pending?.abort();lastReport=null;},
    };
}
