// LittleWhiteBox State 2.0 restores owned roots from checkpoints, then replays WAL.
// A /setvar alone is not part of that replay. Save an exact current-floor baseline
// on explicit front-end writes only (never on polling or history browsing).
export function checkpointState(ctx) {
  const meta = ctx.chatMetadata;
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
