// A single workspace; old stylewriter IDs remain navigation/channel aliases.
import { mount as mountReply } from './index.js';
import { mount as mountRewrite } from '../stylewriter/view.js';
const mounted=new WeakMap();
export function mount(target, options={}) {
    if(mounted.has(target))return mounted.get(target);
    const doc=options.document??globalThis.document;
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text)n.textContent=text;return n;};
    const root=node('section');root.className='amin-writing-workspace';
    const nav=node('nav');nav.className='amin-tabs';nav.setAttribute('aria-label','写作工作页');
    const candidates=node('div'),rewritePane=node('div');
    rewritePane.className='amin-writing-page';rewritePane.dataset.app='stylewriter';
    const buttons=new Map();let active='candidates',reply;
    for(const [id,label] of [['candidates','生成候选'],['rewrite','改写草稿']]){
        const b=node('button',label);b.type='button';b.addEventListener('click',()=>show(id));buttons.set(id,b);nav.append(b);
    }
    root.append(nav,candidates,rewritePane);target.append(root);
    const rewrite=(options.mountRewrite??mountRewrite)(rewritePane,options.rewriteOptions);
    function ensureReply(){
        if(!reply)reply=(options.mountReply??mountReply)({target:candidates,
            onRewrite:(text,identity)=>{rewrite.acceptSource(text,identity);show('rewrite');},
            onManageStyle:()=>{show('rewrite');rewrite.setMode('custom');},
        });
    }
    function show(page){
        active=page==='rewrite'?'rewrite':'candidates';
        candidates.hidden=active!=='candidates';rewritePane.hidden=active!=='rewrite';
        for(const [id,b] of buttons)b.setAttribute('aria-pressed',String(id===active));
        rewrite.open();if(active==='candidates')ensureReply();
    }
    const api={acceptSource(text,identity){rewrite.acceptSource(text,identity);show('rewrite');},open(page){show(page??active);if(active==='candidates'&&!reply)throw Error('请等待聊天输入框加载完成后重试。');},dispose(){reply?.dispose();rewrite.dispose();root.remove();mounted.delete(target);}};
    mounted.set(target,api);show('candidates');return api;
}
