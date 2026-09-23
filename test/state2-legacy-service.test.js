import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateState2, ROOTS } from '../apps/state2/storage.js';
import { createSceneService } from '../apps/scene/service.js';
import { createDiceService } from '../apps/dice/service.js';
import { createJournal } from '../apps/journal/service.js';
import { KEY as JOURNAL_KEY, change, sourceFromRange } from '../apps/journal/model.js';

function apply(metadata, patch) {
    let parent = metadata;
    for (const part of patch.path.slice(0, -1)) parent = parent[part] ??= {};
    if (patch.remove) delete parent[patch.path.at(-1)];
    else parent[patch.path.at(-1)] = structuredClone(patch.value);
}
function nativeChat() {
    let saves = 0;
    const ctx = {
        chatId: 'native-chat', characterId: 0, chat: [{ name: '玩家', is_user: true, mes: '进入旧城。', swipe_id: 0 }],
        chatMetadata: {}, extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        getCurrentChatId() { return this.chatId; },
        saveMetadata: async () => { saves++; },
    };
    const migration = migrateState2(ctx);
    assert.equal(migration.migrated, true);
    for (const patch of migration.patches) apply(ctx.chatMetadata, patch);
    return { ctx, saves: () => saves };
}
const checkpoint = ctx => ctx.chatMetadata.extensions.LittleWhiteBox.stateCkptV2.points['0'];

test('legacy scene confirmation saves its native variable and same-floor checkpoint once', async () => {
    const h = nativeChat(), scene = createSceneService(() => h.ctx, { createId: () => 'scene-1', now: () => '2026-09-23T00:00:00Z' });
    const clock = { year: 1925, month: 12, day: 31, hour: 23, minute: 50, calendarLabel: '' };
    scene.stage('set-time', { clock, reason: '故事起点' });
    await scene.confirm();
    const raw = h.ctx.chatMetadata.variables[ROOTS.scene];
    assert.deepEqual(JSON.parse(raw).clock, clock);
    assert.equal(checkpoint(h.ctx).vars[ROOTS.scene], raw);
    assert.equal(h.saves(), 1);
    scene.dispose();
});

test('migrated scene rejects a manual edit while variable 2.0 is disabled and keeps the preview', async () => {
    const h = nativeChat(), scene = createSceneService(() => h.ctx, { createId: () => 'scene-1' });
    const before = structuredClone(h.ctx.chatMetadata);
    h.ctx.extensionSettings.LittleWhiteBox.variablesMode = '1.0';
    scene.stage('set-time', { clock: { year: 1925, month: 12, day: 31, hour: 23, minute: 50, calendarLabel: '' }, reason: '故事起点' });
    await assert.rejects(scene.confirm(), /启用小白X变量 2\.0/);
    assert.deepEqual(h.ctx.chatMetadata, before);
    assert.ok(scene.preview());
    assert.equal(h.saves(), 0);
    scene.dispose();
});

test('legacy dice save failure retains one fixed roll and its native checkpoint for retry', async () => {
    const h = nativeChat();
    const dice = createDiceService(() => h.ctx, { rng: () => 4, createId: () => 'roll-00000001', now: () => 12345 });
    h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(dice.roll({ formula: 'd6' }), /已固定/);
    const raw = h.ctx.chatMetadata.variables[ROOTS.dice], point = structuredClone(checkpoint(h.ctx));
    assert.equal(JSON.parse(raw).rolls.length, 1);
    assert.equal(point.vars[ROOTS.dice], raw);
    h.ctx.saveMetadata = async () => {};
    await dice.retrySave();
    assert.equal(h.ctx.chatMetadata.variables[ROOTS.dice], raw);
    assert.deepEqual(checkpoint(h.ctx), point);
    assert.equal(dice.history().length, 1);
    dice.dispose();
});

test('native dice preflight failure leaves the draft and fixed roll ready for a later append', async () => {
    const h = nativeChat();
    const dice = createDiceService(() => h.ctx, { rng: () => 4, createId: () => 'roll-00000001', now: () => 12345 });
    const record = await dice.roll({ formula: 'd6' });
    const draft = { value: '行动', dispatchEvent() {}, focus() {} };
    h.ctx.extensionSettings.LittleWhiteBox.variablesMode = '1.0';
    await assert.rejects(dice.append(record.id, draft), /启用小白X变量 2\.0/);
    assert.equal(draft.value, '行动');
    assert.equal(dice.history()[0].status, 'rolled');
    h.ctx.extensionSettings.LittleWhiteBox.variablesMode = '2.0';
    await dice.append(record.id, draft);
    assert.equal(dice.history()[0].status, 'appended');
    assert.ok(draft.value.includes(record.text));
    dice.dispose();
});

test('legacy journal save failure restores the original native root and checkpoint', async () => {
    const h = nativeChat(), journal = createJournal(() => h.ctx);
    const beforeRoot = h.ctx.chatMetadata.variables[ROOTS.journal], beforePoint = structuredClone(checkpoint(h.ctx));
    const token = journal.capture();
    const record = { id: 'hook-1', kind: 'hook', title: '未拆的信', body: '确认信件来历。', actors: [], sources: sourceFromRange(h.ctx.chat, 0, 0) };
    h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(journal.save(token, (store, ctx) => change(store, ctx.chat, 'create', record, token.operationId)), /offline/);
    assert.equal(h.ctx.chatMetadata[JOURNAL_KEY], undefined);
    assert.equal(h.ctx.chatMetadata.variables[ROOTS.journal], beforeRoot);
    assert.deepEqual(checkpoint(h.ctx), beforePoint);
    journal.dispose();
});
