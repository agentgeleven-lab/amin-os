// Shared writing libraries; original presets and task channels stay intact.
import { createStore, containsSecret } from '../stylewriter/model.js';
export const CONTENT_KEY = 'amin_os_content_styles_v1';
export const CONTENT_MODES = [
    {id:'normal',name:'正常模式',key:'normalPrompt',prompt:''},
    {id:'nsfw',name:'NSFW 模式',key:'nsfwPrompt',prompt:''},
    {id:'violence',name:'暴力模式',key:'violencePrompt',prompt:'突出动作冲突、对抗张力与事件后果，保持人物动机和剧情连贯。'},
    {id:'absurd',name:'无厘头模式',key:'absurdPrompt',prompt:'采用荒诞幽默、意外反转和出人意料的联想，保持选项可执行并承接当前情境。'},
];
export const NONE_STYLE = Object.freeze({id:'none',name:'不附加内容风格',description:''});
const contentStores = new WeakMap(), styleStores = new WeakMap();
export function normalizeContent(value) {
    const presets = [];
    for (const item of Array.isArray(value?.presets) ? value.presets : []) {
        if (!item || typeof item.id !== 'string' || !item.id || item.id === 'none' || typeof item.name !== 'string' || !item.name.trim() || presets.some(p => p.id === item.id)) continue;
        presets.push({id:item.id,name:item.name,description:typeof item.description==='string'?item.description:'',updatedAt:item.updatedAt??0});
    }
    return { presets, selectedId: presets.some(p=>p.id===value?.selectedId) ? value.selectedId : presets[0]?.id ?? '', mode:'custom' };
}
export function validateContent(draft, existing, id) {
    const name = String(draft?.name ?? '').trim(), description = String(draft?.description ?? '');
    if (!name || name.length > 40) throw Error('内容风格名称需为 1–40 字。');
    if (name === NONE_STYLE.name || existing.some(p=>p.id!==id && p.name===name)) throw Error('内容风格名称已存在。');
    if (containsSecret(name) || containsSecret(description)) throw Error('请勿在内容风格中保存 API 密钥。');
    return {name, description};
}
export function contentLibrary(getContext) {
    const host = getContext()?.extensionSettings;
    if (!host) throw Error('酒馆设置尚未就绪。');
    if (!contentStores.has(host)) {
        const legacy = host.reply_options_mvp ?? {};
        const seeds = CONTENT_MODES.map(m=>({id:m.id,name:m.name,description:typeof legacy[m.key]==='string'?legacy[m.key]:m.prompt}));
        contentStores.set(host, createStore(getContext, {key:CONTENT_KEY,seeds,normalize:normalizeContent,validate:validateContent}));
    }
    return contentStores.get(host);
}
export function styleLibrary(getContext) {
    const host = getContext()?.extensionSettings;
    if (!host) throw Error('酒馆设置尚未就绪。');
    if (!styleStores.has(host)) styleStores.set(host, createStore(getContext));
    return styleStores.get(host);
}
export function contentSelection(library, id) { return id==='none' ? NONE_STYLE : library.get(id) ?? NONE_STYLE; }
export function contentInstruction(style, rewrite=false) {
    if (!style?.description?.trim()) return '';
    return `\n用户选择的${style.name}附加要求：\n${style.description}${rewrite?'\n内容风格仅调整原文内容的呈现重点，不得改变事实、人物关系、事件顺序或新增情节；与保留原意约束冲突时以原意为准。':''}`;
}
export function writingInstruction({mode='none',preset,samples}={}) {
    if (mode==='none') return '';
    if (mode==='custom') {
        if (!preset) throw Error('文风预设已不存在，请重新选择。');
        return `\n目标文风：${preset.name}\n文风说明：\n${preset.description}\n文风只影响表达，不改变回复主体、人称或输出格式。`;
    }
    if (!samples?.samples?.length) throw Error('当前聊天没有可参考的正文。');
    return `\n参考当前聊天文风：仅学习用词、句式和节奏，不得复制样本人物或事件，不改变回复主体、人称或输出格式。\n${JSON.stringify(samples.samples)}`;
}
