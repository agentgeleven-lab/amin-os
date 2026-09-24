import { assertChatReady } from './chat-lifecycle.js';

// A history observer may assign stable message IDs before any user action.
// Keep that fact outside chat metadata so observation alone never saves data.
const pendingIds = new WeakMap();
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
export async function saveChatMetadata(ctx) {
  assertChatReady(ctx);
  const metadata = ctx?.chatMetadata;
  const marker = metadata && pendingIds.get(metadata);
  if (marker?.identity === identity(ctx) && typeof ctx.saveChat === 'function') {
    await ctx.saveChat();
    if (pendingIds.get(metadata) === marker) pendingIds.delete(metadata);
    return 'chat';
  }
  await ctx.saveMetadata();
  return 'metadata';
}
