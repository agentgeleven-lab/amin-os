import { assertChatReady } from './chat-lifecycle.js';
import { performanceDiagnostics } from './performance-diagnostics.js';

// A history observer may assign stable message IDs before any user action.
// Keep that fact outside chat metadata so observation alone never saves data.
const pendingIds = new WeakMap();
const preparations = new Set();
/** External records must exist before a chat starts referring to them.
 * Preparations may return a synchronous check, run after all preparations.
 */
export function registerChatSavePreparation(prepare) {
  preparations.add(prepare);
  return () => preparations.delete(prepare);
}
const identity = ctx => JSON.stringify([
  ctx?.groupId ?? null,
  ctx?.characters?.[ctx?.characterId]?.avatar ?? ctx?.characterId ?? null,
  ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null,
]);

export function markChatIdsDirty(ctx) {
  const metadata = ctx?.chatMetadata;
  if (!metadata || typeof metadata !== 'object') return;
  pendingIds.set(metadata, { identity: identity(ctx) });
}

/** Persist metadata and newly assigned message IDs in one host save. */
export async function saveChatMetadata(ctx, { prepared: receipts } = {}) {
  assertChatReady(ctx);
  const metadata = ctx?.chatMetadata;
  const prepared = performanceDiagnostics.begin('prepare');
  try {
    const checks = [];
    for (const prepare of preparations) {
      const check = await prepare(ctx, receipts?.get(prepare));
      if (typeof check === 'function') checks.push(check);
    }
    // No await between these checks and dispatching the host save: a later
    // preparation must not invalidate an earlier external-state reference.
    for (const check of checks) check();
    prepared();
  }
  catch(error) { prepared({failed:true}); throw error; }
  assertChatReady(ctx);
  const marker = metadata && pendingIds.get(metadata);
  if (marker?.identity === identity(ctx) && typeof ctx.saveChat === 'function') {
    const finished = performanceDiagnostics.begin('chatSave');
    try { await ctx.saveChat(); finished(); } catch(error) { finished({failed:true}); throw error; }
    if (pendingIds.get(metadata) === marker) pendingIds.delete(metadata);
    return 'chat';
  }
  const finished = performanceDiagnostics.begin('metadataSave');
  try { await ctx.saveMetadata(); finished(); } catch(error) { finished({failed:true}); throw error; }
  return 'metadata';
}
