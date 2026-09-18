export function endpoint(value='http://127.0.0.1:9883') {
 const url=new URL(value); if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('语音地址必须是本机 localhost 或 127.0.0.1');
 return url.origin;
}
export function chunks(text,limit=220){
 const result=[];let rest=String(text).trim();while(rest){let end=Math.min(limit,rest.length);if(end<rest.length){const head=rest.slice(0,end);const cut=Math.max(head.lastIndexOf('。'),head.lastIndexOf('！'),head.lastIndexOf('？'),head.lastIndexOf('；'),head.lastIndexOf('\n'));if(cut>=limit/3)end=cut+1;if(/[\uD800-\uDBFF]/.test(rest[end-1]))end--;}
 const part=rest.slice(0,end).trim();if(part)result.push(part);rest=rest.slice(end).trim();}return result;
}
export function plainText(text){return String(text??'').replace(/```[\s\S]*?```/g,'').replace(/<(script|style|details|think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]+>/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/^[#>]+\s*/gm,'').replace(/[*_`~]/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();}

export function mimoEndpoint(config){
 if(!config.remote)return endpoint(config.url);
 const url=new URL(config.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('远程 DXL1 地址须为 HTTPS 域名，不包含路径或凭据');
 if(!config.remoteKey?.trim())throw Error('请填写电脑生成的远程访问密钥');return url.origin;
}
export function remoteHeaders(config){return config.remote?{Authorization:'Bearer '+config.remoteKey.trim()}:{};}
