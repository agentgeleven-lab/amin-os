// Shared workspace for the OS pane and independently scoped message-floor windows.
import { mount as mountReply } from './index.js';
import { mount as mountRewrite } from '../stylewriter/view.js';
const mounted=new WeakMap();
export function mount(target, options={}) {
    if(mounted.has(target))return mounted.get(target);
    const doc=options.document??globalThis.document;
    const hostContext=options.getContext??options.rewriteOptions?.getContext??(()=>globalThis.SillyTavern?.getContext?.());
    const context=()=>{
        const ctx=hostContext();
        if(options.contextProvider){if(!ctx)throw Error('聊天尚未就绪，请重新打开窗口。');return options.contextProvider(ctx);}
        return ctx;
    };
    context(); // Validate floor ownership before creating DOM or listeners.
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text)n.textContent=text;return n;};
    const root=node('section');root.className='amin-writing-workspace';
    const nav=node('nav');nav.className='amin-tabs';nav.setAttribute('aria-label','写作工作页');
    const notice=node('p');notice.setAttribute('role','status');notice.hidden=true;
    const candidates=node('div'),rewritePane=node('div');
    rewritePane.className='amin-writing-page';rewritePane.dataset.app='stylewriter';
    const buttons=new Map();let active='candidates',reply,rewrite,disposed=false;
    for(const [id,label] of [['candidates','生成候选'],['rewrite','改写草稿']]){
        const b=node('button',label);b.type='button';
        b.addEventListener('click',()=>{try{show(id);}catch(error){notice.textContent=error.message;notice.hidden=false;}});
        buttons.set(id,b);nav.append(b);
    }
    root.append(nav,notice,candidates,rewritePane);target.append(root);
    function ensureReply(){
        if(!reply)reply=(options.mountReply??mountReply)({target:candidates,
            instanceId:options.instanceId,headingText:options.headingText,
            getContext:hostContext,contextProvider:options.contextProvider,
            onRewrite:(text,identity)=>{context();rewrite.acceptSource(text,identity);show('rewrite');},
            onManageStyle:()=>{show('rewrite');rewrite.setMode('custom');},
        });
    }
    function show(page){
        if(disposed)throw Error('窗口已关闭，请重新打开。');
        context();rewrite.open();
        active=page==='rewrite'?'rewrite':'candidates';
        candidates.hidden=active!=='candidates';rewritePane.hidden=active!=='rewrite';
        for(const [id,b] of buttons)b.setAttribute('aria-pressed',String(id===active));
        if(active==='candidates')ensureReply();
        notice.hidden=true;
    }
    function dispose(){
        if(disposed)return;disposed=true;
        try{reply?.dispose();}finally{try{rewrite?.dispose();}finally{root.remove();mounted.delete(target);}}
    }
    const api={
        acceptSource(text,identity){context();rewrite.acceptSource(text,identity);show('rewrite');},
        open(page){show(page??active);if(active==='candidates'&&!reply)throw Error('请等待聊天输入框加载完成后重试。');},
        dispose,
    };
    try{
        rewrite=(options.mountRewrite??mountRewrite)(rewritePane,{
            ...options.rewriteOptions,document:doc,getContext:context,settingsContext:hostContext,
            instanceId:options.instanceId?options.instanceId+'-rewrite':undefined,
        });
        show('candidates');mounted.set(target,api);return api;
    }catch(error){dispose();throw error;}
}
