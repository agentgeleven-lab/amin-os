// Run Amin's native-variable bridge against LittleWhiteBox's real State 2.0
// parser, guard, WAL and replay engine in an isolated in-memory host.
// Set AMIN_LWB_PATH to a checked-out LittleWhiteBox directory. The fallback is
// a historical local fork; use the current upstream checkout for the release gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    ROOTS, MIGRATION_KEY, migrateState2, projectState2, manualState2Patches,
} from '../apps/state2/storage.js';
import {
    KEY as CHARACTER_KEY, appendSnapshot as appendCharacters, emptyStore as emptyCharacters,
    readCharacters,
} from '../apps/characters/model.js';
import {
    KEY as INVENTORY_KEY, change as changeInventory, emptyStore as emptyInventory,
    readInventory,
} from '../apps/inventory/model.js';
import {
    KEY as SCENE_KEY, appendEvent as appendScene, emptyState as emptyScene,
    emptyStore as emptySceneStore, readCurrentScene, transition as transitionScene,
} from '../apps/scene/model.js';
import { rollBatch, formatRoll } from '../apps/dice/engine.js';
import { createState2Runtime } from '../apps/state2/runtime.js';

const localFork = 'C:/Users/soh82/Documents/Codex/2026-09-14/referenced-chatgpt-conversation-this-is-an/work/LittleWhiteBox-AsyncPresets';
const lwb = process.env.AMIN_LWB_PATH || localFork;
const strictReplay = process.argv.includes('--require-migration-replay');
const sourceDir = path.join(lwb, 'modules/variables/state2');
if (!fs.existsSync(path.join(sourceDir, 'executor.js'))) {
    throw Error('Set AMIN_LWB_PATH to a LittleWhiteBox checkout containing modules/variables/state2.');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-state2-engine-'));
fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(temp, 'env.js'), `let context;
export function setContext(value) { context = value; }
export function getContext() { return context; }
export function getLocalVariable(key) { return context.chatMetadata.variables[key] ?? ''; }
export function setLocalVariable(key, value) { context.chatMetadata.variables[key] = value; }
`);
for (const file of ['parser.js', 'semantic.js', 'guard-core.js', 'guard.js', 'executor.js']) {
    let code = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    code = code.replace("import jsyaml from '../../../libs/js-yaml.mjs';", 'import jsyaml from ' + JSON.stringify(pathToFileURL(path.join(lwb, 'libs/js-yaml.mjs')).href) + ';');
    code = code.replaceAll("from '../../../../../../extensions.js'", "from './env.js'");
    code = code.replaceAll("from '../../../../../../variables.js'", "from './env.js'");
    fs.writeFileSync(path.join(temp, file), code);
}
const env = await import(pathToFileURL(path.join(temp, 'env.js')).href);
const engine = await import(pathToFileURL(path.join(temp, 'executor.js')).href);
const clone = value => structuredClone(value);
const parse = value => typeof value === 'string' ? JSON.parse(value) : clone(value);
function applyPatches(metadata, patches) {
    for (const patch of patches) {
        let parent = metadata;
        for (const key of patch.path.slice(0, -1)) parent = parent[key] ??= {};
        if (patch.remove) delete parent[patch.path.at(-1)];
        else parent[patch.path.at(-1)] = clone(patch.value);
    }
}
function msg(mes, name = '助手', is_user = false) { return { name, is_user, mes, swipe_id: 0 }; }
function makeContext() {
    return {
        chatId: 'engine-smoke', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'engine-smoke.png' }],
        chat: [msg('开场', '玩家', true)],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chatMetadata: { variables: { unrelated: 'keep-variable' }, LWB_RULES_V2: {}, extensions: {}, unrelatedMetadata: { keep: true } },
        async saveMetadata() {}, saveMetadataDebounced() {}, async saveChat() {},
    };
}
const world = { 版本: 1, 项目: { HK416: { 心智状态: '稳定（严谨戒备）' } } };
const ctx = makeContext();
env.setContext(ctx);
const state0 = `<state>\n状态栏: ${JSON.stringify(world)}\n</state>`;
ctx.chat[0].mes = state0;
const seed = engine.applyStateForMessage(0, state0);
assert.equal(seed.errors.length, 0, JSON.stringify(seed.errors));
assert.deepEqual(parse(ctx.chatMetadata.variables.状态栏), world);

ctx.chat.push(msg('来到工坊'));
ctx.chatMetadata[CHARACTER_KEY] = appendCharacters(emptyCharacters(), ctx.chat, {
    version: 1, characters: [{ id: 'hk416', name: 'HK416', kind: 'npc', notes: '初始人物', stats: [] }],
}, { id: 'character_seed', at: '2026-09-24T00:00:00Z' });
ctx.chatMetadata[INVENTORY_KEY] = changeInventory(emptyInventory(), ctx.chat, 'save-item', {
    ownerId: 'hk416', name: '急救包', quantity: 5, equipped: false, notes: '', reason: '初始物品',
}, { ownerIds: ['hk416'], createId: (() => { let n = 0; return () => `inventory_${++n}`; })(), at: '2026-09-24T00:00:00Z' }).store;
const clock = { year: 1925, month: 1, day: 2, hour: 10, minute: 30, calendarLabel: '' };
const sceneSeed = transitionScene(emptyScene(), 'set-time', { clock, reason: '初始时间' }, { at: '2026-09-24T00:00:00Z' });
ctx.chatMetadata[SCENE_KEY] = appendScene(emptySceneStore(), ctx.chat, { ...sceneSeed, op: 'set-time' }, { eventId: 'scene_seed', at: '2026-09-24T00:00:00Z' });
const diceResult = rollBatch({ formula: '1d20' }, () => 12);
const diceRecord = { id: 'roll_seed', createdAt: 1234, settings: diceResult.settings, results: diceResult.results, status: 'rolled', rerollOf: null };
diceRecord.text = formatRoll(diceRecord);
ctx.chatMetadata.amin_os_dice_v1 = { version: 1, rolls: [diceRecord] };

const originalLegacy = Object.fromEntries([CHARACTER_KEY, INVENTORY_KEY, SCENE_KEY, 'amin_os_dice_v1'].map(key => [key, clone(ctx.chatMetadata[key])]));
const migration = migrateState2(ctx);
assert.ok(migration.patches.length > 0, 'Migration must create native roots and a baseline.');
applyPatches(ctx.chatMetadata, migration.patches);
assert.ok(ctx.chatMetadata[MIGRATION_KEY], 'Migration marker is missing.');
for (const [module, root] of Object.entries(ROOTS)) {
    if (module === 'map') continue; // An empty map has no valid document or variable payload.
    assert.ok(Object.hasOwn(ctx.chatMetadata.variables, root), `Native root ${root} is missing.`);
}
for (const [key, value] of Object.entries(originalLegacy)) assert.deepEqual(ctx.chatMetadata[key], value, `Migration rewrote ${key}.`);
assert.equal(ctx.chatMetadata.variables.unrelated, 'keep-variable');
assert.deepEqual(ctx.chatMetadata.unrelatedMetadata, { keep: true });
assert.ok(ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['1'], 'Migration floor checkpoint is missing.');
assert.ok(ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1']?.roots?.length, 'Ownership sentinel is missing.');

// Manual edits must update the native root and the same floor's checkpoint.
const manual = { ...ctx, chatMetadata: clone(ctx.chatMetadata), chat: clone(ctx.chat) };
const renamed = clone(readCharacters(manual));
renamed.characters[0].notes = '用户手动补充';
const manualStore = appendCharacters(manual.chatMetadata[CHARACTER_KEY], manual.chat, renamed, { id: 'character_manual', at: '2026-09-24T00:01:00Z' });
const manualInput = [{ path: [CHARACTER_KEY], value: manualStore }];
const manualExpansion = manualState2Patches(manual, manualInput);
assert.ok(manualExpansion.patches.some(patch => patch.path[0] === 'variables' && patch.path[1] === ROOTS.characters), 'Manual write has no native character patch.');
applyPatches(manual.chatMetadata, [...manualInput, ...manualExpansion.patches]);
assert.equal(parse(manual.chatMetadata.variables[ROOTS.characters]).characters[0].notes, '用户手动补充');
assert.equal(parse(manual.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['1'].vars[ROOTS.characters]).characters[0].notes, '用户手动补充');

const migratedMetadata = clone(ctx.chatMetadata);
function branch(id, state) {
    const branchContext = { ...ctx, chatId: id, chat: clone(ctx.chat), chatMetadata: clone(migratedMetadata) };
    branchContext.chat.push(msg(state));
    env.setContext(branchContext);
    const output = engine.applyStateForMessage(2, state);
    assert.equal(output.errors.length, 0, `${id}: ${JSON.stringify(output.errors)}`);
    const projected = projectState2(branchContext);
    applyPatches(branchContext.chatMetadata, projected.patches);
    return { ctx: branchContext, output };
}
const stateA = `<state>\n${ROOTS.characters}.characters.0.notes: 已解除心智锁\n${ROOTS.inventory}.items.0.quantity: -1\n${ROOTS.scene}.clock.minute: (45)\n状态栏.项目.HK416.心智状态: 完全解锁\n</state>`;
const stateB = `<state>\n${ROOTS.characters}.characters.0.notes: 保持戒备\n${ROOTS.inventory}.items.0.quantity: -2\n${ROOTS.scene}.clock.minute: (40)\n状态栏.项目.HK416.心智状态: 谨慎\n</state>`;
const a = branch('branch-a', stateA);
assert.equal(parse(a.ctx.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 4);
assert.equal(readCharacters(a.ctx).characters[0].notes, '已解除心智锁');
assert.equal(readInventory(a.ctx).items[0].quantity, 4);
assert.equal(readCurrentScene(a.ctx).clock.minute, 45);
assert.equal(parse(a.ctx.chatMetadata.variables.状态栏).项目.HK416.心智状态, '完全解锁');
env.setContext(a.ctx);
const repeat = engine.applyStateForMessage(2, stateA);
assert.equal(repeat.skipped, true, 'Same floor was not deduplicated.');
assert.equal(parse(a.ctx.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 4, 'Duplicate floor decremented inventory again.');
const b = branch('branch-b', stateB);
assert.equal(parse(b.ctx.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 3);
assert.equal(readCharacters(b.ctx).characters[0].notes, '保持戒备');
assert.equal(parse(a.ctx.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 4, 'A branch was modified by B.');

env.setContext(a.ctx);
await engine.restoreStateV2ToFloor(1);
a.ctx.chat.pop();
applyPatches(a.ctx.chatMetadata, projectState2(a.ctx).patches);
assert.equal(parse(a.ctx.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 5);
assert.equal(readInventory(a.ctx).items[0].quantity, 5);
assert.equal(readCharacters(a.ctx).characters[0].notes, '初始人物');
assert.equal(parse(a.ctx.chatMetadata.variables.状态栏).项目.HK416.心智状态, '稳定（严谨戒备）');
a.ctx.chat.push(msg(stateA));
await engine.restoreStateV2ToFloor(2);
applyPatches(a.ctx.chatMetadata, projectState2(a.ctx).patches);
assert.equal(readInventory(a.ctx).items[0].quantity, 4, 'Floor 2 replay did not recover inventory.');
assert.equal(readCurrentScene(a.ctx).clock.minute, 45);
assert.equal(a.ctx.chatMetadata.variables.unrelated, 'keep-variable');
assert.deepEqual(a.ctx.chatMetadata.unrelatedMetadata, { keep: true });

// Advanced compatibility: moving before the migration floor and then forward.
// Historical Xiaobai forks drop future checkpoints during restore; current
// upstream retains the migration baseline and can replay it.
const preMigration = { ...ctx, chatId: 'pre-migration-replay', chat: clone(ctx.chat), chatMetadata: clone(migratedMetadata) };
env.setContext(preMigration);
await engine.restoreStateV2ToFloor(0);
preMigration.chat.pop();
applyPatches(preMigration.chatMetadata, projectState2(preMigration).patches);
const cleared = !Object.hasOwn(preMigration.chatMetadata.variables, ROOTS.characters);
assert.ok(cleared, 'Native character root did not clear before migration floor.');
preMigration.chat.push(msg('来到工坊'));
await engine.restoreStateV2ToFloor(1);
const advancedReplay = Object.hasOwn(preMigration.chatMetadata.variables, ROOTS.characters)
    && parse(preMigration.chatMetadata.variables[ROOTS.characters]).characters[0]?.id === 'hk416';
if (strictReplay) assert.ok(advancedReplay, 'Migration baseline cannot replay after returning from an earlier floor.');

// A pre-existing World Status variable may have been written by the host's
// variable editor, without a State 2.0 WAL. The migration ownership marker
// still needs to make it follow the chat floor during native replay.
const statusOnly = makeContext();
statusOnly.chat.push(msg('等待迁移'));
statusOnly.chatMetadata.variables.状态栏 = JSON.stringify(world);
env.setContext(statusOnly);
applyPatches(statusOnly.chatMetadata, migrateState2(statusOnly).patches);
assert.ok(statusOnly.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'].roots.includes('状态栏'));
await engine.restoreStateV2ToFloor(0);
assert.equal(statusOnly.chatMetadata.variables.状态栏, undefined, 'Status root remained at a pre-migration floor.');
assert.equal(statusOnly.chatMetadata.variables.unrelated, 'keep-variable');
await engine.restoreStateV2ToFloor(1);
const nativeStatusReplay = parse(statusOnly.chatMetadata.variables.状态栏 ?? '{}').项目?.HK416?.心智状态 === '稳定（严谨戒备）';
if (strictReplay) assert.ok(nativeStatusReplay, 'Status root did not return at the migration floor.');

// Model a newly opened branch whose metadata was copied from a later floor.
// Amin's runtime must ask the real native engine to rewind first, then hydrate
// an app view that was also stale at this branch's current path.
const switched = { ...ctx, chatId: 'new-branch-lifecycle', chat: clone(ctx.chat), chatMetadata: clone(a.ctx.chatMetadata) };
const staleCharacter = clone(readCharacters(switched));
staleCharacter.characters[0].notes = '复制来的后续状态';
switched.chatMetadata[CHARACTER_KEY] = appendCharacters(switched.chatMetadata[CHARACTER_KEY], switched.chat,
    staleCharacter, { id: 'stale_branch_view', at: '2026-09-24T00:02:00Z' });
assert.equal(readCharacters(switched).characters[0].notes, '复制来的后续状态');
assert.equal(parse(switched.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 4);
let nativeApplyCalls = 0;
const replayCalls = [];
const runtime = createState2Runtime(() => switched, {
    interval: 0,
    host: { LWB_StateV2: { applyText() { nativeApplyCalls++; throw Error('Amin must not execute a model state block.'); } } },
    restoreNative: async floor => {
        replayCalls.push(floor);
        env.setContext(switched);
        const result = await engine.restoreStateV2ToFloor(floor);
        return { restored: result?.ok === true, stale: false, source: 'real-engine', result };
    },
});
try {
    await runtime.restoreChat();
    assert.deepEqual(replayCalls, [1]);
    assert.equal(runtime.ready(switched), true);
    assert.equal(parse(switched.chatMetadata.variables[ROOTS.inventory]).items[0].quantity, 5);
    assert.equal(parse(switched.chatMetadata.variables.状态栏).项目.HK416.心智状态, '稳定（严谨戒备）');
    assert.equal(readCharacters(switched).characters[0].notes, '初始人物', 'Amin did not hydrate the branch app view after native replay.');
    assert.equal(readInventory(switched).items[0].quantity, 5);
    assert.equal(nativeApplyCalls, 0);
} finally { runtime.destroy(); }

// Dice rolls come from the local random generator. The native guard's $ro is
// path-local, so separately inspect a nested set, delete and array append.
// Regardless of native acceptance, Amin must refuse to project any such WAL.
const diceRoot = ROOTS.dice;
const forged = { ...clone(diceRecord), id: 'forged_roll' };
const diceAttempts = [
    { action: 'nested set', text: `${diceRoot}.rolls.0.results.0.total: (999)` },
    { action: 'nested delete', text: `${diceRoot}.rolls.0.results.0.total: null` },
    { action: 'array append', text: `${diceRoot}.rolls: +${JSON.stringify(forged)}` },
];
const diceGuard = [];
for (const attempt of diceAttempts) {
    const candidate = { ...ctx, chatId: `dice-${attempt.action}`, chat: clone(ctx.chat), chatMetadata: clone(migratedMetadata) };
    candidate.chat.push(msg(`<state>\n${attempt.text}\n</state>`));
    env.setContext(candidate);
    const before = clone(candidate.chatMetadata.variables[diceRoot]);
    const result = engine.applyStateForMessage(2, candidate.chat[2].mes);
    const nativeChanged = !Object.is(before, candidate.chatMetadata.variables[diceRoot]);
    let projectionRejected = false;
    try { applyPatches(candidate.chatMetadata, projectState2(candidate).patches); }
    catch (error) { assert.match(error.message, /骰子/); projectionRejected = true; }
    assert.ok(!nativeChanged || projectionRejected, `Amin projected a ${attempt.action} accepted by the native engine.`);
    assert.deepEqual(candidate.chatMetadata.amin_os_dice_v1, originalLegacy.amin_os_dice_v1, 'AI changed the local dice history.');
    diceGuard.push({ action: attempt.action, engineRejected: result.errors.length > 0, nativeChanged, projectionRejected });
}

env.setContext(b.ctx);
await engine.trimStateV2FromFloor(2);
assert.ok(b.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['-1'], 'Trim removed ownership sentinel.');
assert.equal(b.ctx.chatMetadata.extensions.LittleWhiteBox.stateLogV2.floors['2'], undefined);
console.log(JSON.stringify({
    result: advancedReplay ? 'PASS' : 'PARTIAL',
    source: lwb, strictReplay,
    checks: ['native migration', 'manual write checkpoint', 'real <state> changes', 'app hydration', 'floor replay', 'runtime branch restore', 'branch isolation', 'same-floor deduplication', 'trim ownership', 'unrelated variable preservation'],
    advancedReplay,
    nativeStatusReplay,
    runtimeBranchReplay: true,
    diceGuard,
    limitations: [
        ...(!advancedReplay || !nativeStatusReplay ? ['This engine drops future checkpoints when restoring an earlier floor; migration baselines cannot replay.'] : []),
        ...(diceGuard.some(item => item.nativeChanged) ? ['The native engine accepts a nested dice deletion; Amin refuses to project it, but the native variable is changed.'] : []),
    ],
}, null, 2));
