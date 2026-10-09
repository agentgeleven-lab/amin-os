// LittleWhiteBox State 2.0 restores owned roots from checkpoints, then replays WAL.
// A /setvar alone is not part of that replay. Save an exact current-floor baseline
// on explicit front-end writes only (never on polling or history browsing).
const currentWriteListeners = new Set();

/** Explicit front-end writes can release navigation protection without a checkpoint. */
export function registerCurrentCheckpointWrite(callback) {
  if (typeof callback !== 'function') throw TypeError('Current checkpoint write listener must be a function');
  currentWriteListeners.add(callback);
  return () => currentWriteListeners.delete(callback);
}

export function checkpointState(ctx) {
  const meta = ctx.chatMetadata;
  // Current-only storage writes its single bounded native baseline during the
  // save transaction. The legacy full checkpoint would duplicate unrelated
  // variables at every manually edited floor and remove baseline provenance.
  // Keep these constants local to avoid the storage/checkpoint import cycle.
  const current = meta?.amin_os_current_story_v1;
  if (current?.version === 1 && current?.owner === 'amin-os/current-story-v1') {
    for (const callback of currentWriteListeners) callback(ctx);
    return false;
  }
  const lwb = meta?.extensions?.LittleWhiteBox;
  if (ctx.extensionSettings?.LittleWhiteBox?.variablesMode === '1.0') return false;
  const enabled = ctx.extensionSettings?.LittleWhiteBox?.variablesMode === '2.0';
  if (!enabled && !lwb?.stateLogV2 && !lwb?.stateCkptV2) return false;
  const floor = (ctx.chat?.length || 0) - 1;
  if (floor < 0) return false;
  if ((lwb?.stateCkptV2?.version ?? 1) !== 1 || (lwb?.stateLogV2?.version ?? 1) !== 1) {
    throw Error('小白X记录格式已改变，无法安全同步状态栏，请更新插件。');
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  // A checkpoint is global to State 2.0: retain ALL roots and rules at this floor.
  const point = { vars: clone(meta.variables || {}), rules: clone(meta.LWB_RULES_V2 || {}), ts: Date.now() };
  meta.extensions ??= {};
  meta.extensions.LittleWhiteBox ??= {};
  const owner = meta.extensions.LittleWhiteBox;
  owner.stateCkptV2 ??= { version: 1, every: 50, points: {} };
  owner.stateCkptV2.points ??= {};
  owner.stateCkptV2.points[String(floor)] = point;
  ctx.saveMetadataDebounced?.();
  return true;
}
