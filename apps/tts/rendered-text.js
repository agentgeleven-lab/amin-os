// Read the host-rendered message after its display regexes; never fall back to raw chat data.
export function readRenderedMessage(messageElement){
 const root=messageElement?.querySelector('.mes_text');
 if(!root||!root.isConnected)return '';
 const styleOf=node=>node.ownerDocument.defaultView.getComputedStyle(node);
 const excluded='script,style,template,iframe,canvas,svg,button,input,textarea,select,audio,video,[role="button"],.amin-floor,.amin-extra-floor,.mes_buttons,.mes_edit_buttons';
 const pieces=[];
 function visit(node){
  if(node.nodeType===3){pieces.push(node.nodeValue);return;}
  if(node.nodeType!==1||node.matches(excluded)||node.hidden)return;
  const style=styleOf(node);
  if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||style.contentVisibility==='hidden')return;
  if(node.tagName==='BR'){pieces.push('\n');return;}
  const block=['block','flex','grid','list-item','table','table-row'].includes(style.display);
  if(block)pieces.push('\n');
  const children=node.tagName==='DETAILS'&&!node.open?[...node.children].filter(n=>n.tagName==='SUMMARY'):node.childNodes;
  for(const child of children)visit(child);
  if(block)pieces.push('\n');
 }
 visit(root);
 return pieces.join('').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
