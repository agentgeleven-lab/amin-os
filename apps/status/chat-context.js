// Every status operation uses the same recent conversation and a request-local preset.
export function readStatusChat(ctx) {
  return (ctx.chat || []).filter(m => !m.is_system && typeof m.mes === 'string' && m.mes.trim()).slice(-20)
    .map(m => ({角色: m.name || (m.is_user ? ctx.name1 : ctx.name2) || '角色', 内容: m.mes}));
}
export function requireStatusChat(snapshot) {
  if (!snapshot) return snapshot;
  const result = structuredClone(snapshot);
  const blocks = result.preset.blocks;
  if (!blocks.some(b => b.type === 'chat' && b.enabled)) blocks.push({type:'chat', role:'user', enabled:true, text:''});
  return result;
}
