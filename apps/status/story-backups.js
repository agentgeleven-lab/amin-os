import { getState2Runtime } from '../state2/runtime.js';

export const STORY_STORAGE_KEY = 'amin_os_story_storage_v2';
const STATE_ID = /^sha256:[a-f0-9]{64}$/u;
const MAX_BACKUPS = 5;
const MAX_LABEL = 160;

export const usesStoryStorage = ctx => ctx?.chatMetadata?.[STORY_STORAGE_KEY]?.version === 2;

export function storyBackups(ctx) {
  if (!usesStoryStorage(ctx)) return [];
  const values = ctx.chatMetadata[STORY_STORAGE_KEY].backups ?? [];
  if (!Array.isArray(values) || values.length > MAX_BACKUPS || values.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item) || !STATE_ID.test(item.stateId) ||
    typeof item.label !== 'string' || item.label.length > MAX_LABEL || !Number.isFinite(item.at)))
    throw Error('外置状态备份引用格式无效，已停止修改备份。');
  return values;
}

export async function captureStoryBackup(ctx, { label = '状态栏操作前', archive = () => getState2Runtime()?.archiveStory?.() } = {}) {
  if (!usesStoryStorage(ctx)) return null;
  storyBackups(ctx);
  if (typeof archive !== 'function') throw Error('外置剧情存储尚未就绪，无法建立恢复点。');
  const result = await archive();
  const stateId = typeof result === 'string' ? result : result?.stateId;
  if (!STATE_ID.test(stateId ?? '')) throw Error('外置剧情存储未返回有效状态编号，已停止修改状态栏。');
  return { stateId, label: String(label).slice(0, MAX_LABEL), at: Date.now() };
}

// Call under the operation's metadata write lease, immediately before its
// existing host save. Only a short reference is added to chat metadata.
export function recordStoryBackup(ctx, backup) {
  if (!backup) return false;
  if (!usesStoryStorage(ctx)) throw Error('外置剧情存储模式已变化，未记录恢复点。');
  const existing = storyBackups(ctx);
  const entry = { stateId: backup.stateId, label: backup.label, at: backup.at };
  if (!STATE_ID.test(entry.stateId ?? '') || typeof entry.label !== 'string' || entry.label.length > MAX_LABEL || !Number.isFinite(entry.at))
    throw Error('外置状态备份引用无效，未记录恢复点。');
  ctx.chatMetadata[STORY_STORAGE_KEY].backups = [...existing, entry].slice(-MAX_BACKUPS);
  return true;
}
