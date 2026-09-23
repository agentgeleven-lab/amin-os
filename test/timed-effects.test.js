import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, empty, change, activeEffects, timedEffects, splitEffect, compile, currentPrompt, expiryPreview, contextExpiryPreview, snapshotEffects, validateEffectsSnapshot, restoreEffects, consumedActionIds } from '../apps/effects/model.js';
import { createEffects, PROMPT_KEY } from '../apps/effects/service.js';
import { clockMinutes, timingStatus } from '../apps/effects/timing.js';
import { KEY as SCENE_KEY, emptyStore, emptyState, transition, appendEvent, readCurrentScene, advanceClock } from '../apps/scene/model.js';
import { createOperationService } from '../apps/shared/operations.js';
import { createSceneService } from '../apps/scene/service.js';

const clock = { year: 2024, month: 2, day: 29, hour: 23, minute: 40, calendarLabel: '游戏历' };
const chat = () => [{ name: '旅人', is_user: true, mes: '出发', swipe_id: 0 }];
const seed = () => ({ ...empty(), skills: [{ id: 's', name: '防护', book: '自定义', entryId: '1', reminder: '提供防护', original: '原规则' }] });
const data = { skillId: 's', holder: '旅人', target: '同行者', scope: '伤害防护', command: '', condition: '受到破除时人工解除', durationMinutes: 30 };
const create = (minutes = 30, c = chat()) => change(seed(), c, 'create', { ...data, durationMinutes: minutes }, { clock });
const visible = (store, at = clock, c = chat()) => timedEffects(store, c, at)[0];
function setClock(ctx, value, id = 'clock-' + (ctx.chatMetadata[SCENE_KEY]?.events.length ?? 0)) {
    const result = transition(readCurrentScene(ctx), 'set-time', { clock: value, reason: '确认时间' });
    ctx.chatMetadata[SCENE_KEY] = appendEvent(ctx.chatMetadata[SCENE_KEY] ?? emptyStore(), ctx.chat, { ...result, op: 'set-time' }, { eventId: id, at: '2026-09-23T00:00:00Z' });
}
function fixture() {
    const handlers = {}, prompts = new Map();
    const ctx = { getCurrentChatId: () => 'chat-a', chat: chat(), chatMetadata: { [KEY]: seed() }, saveMetadata: async () => {}, setExtensionPrompt: (key, value) => prompts.set(key, value), eventTypes: { GENERATION_AFTER_COMMANDS: 'start', CHAT_CHANGED: 'chat', GENERATION_ENDED: 'end' }, eventSource: { on: (event, fn) => handlers[event] = fn, removeListener() {} } };
    setClock(ctx, clock);
    return { ctx, handlers, prompts, api: createEffects(() => ctx) };
}

test('calendar conversion is exact across leap days, midnight and early years', () => {
    assert.equal(clockMinutes(advanceClock(clock, 30)) - clockMinutes(clock), 30);
    assert.equal(advanceClock(clock, 30).day, 1);
    const early = { ...clock, year: 1, month: 1, day: 1, hour: 0, minute: 0 };
    assert.equal(clockMinutes(advanceClock(early, 1)) - clockMinutes(early), 1);
});

test('duration is opt-in; arbitrary free-text conditions are not parsed', () => {
    const state = change(seed(), chat(), 'create', { ...data, durationMinutes: undefined, condition: '持续30分钟' });
    assert.equal(visible(state).timing, undefined);
    assert.equal(visible(state).timingStatus.state, 'untimed');
    assert.match(compile(state, chat()), /持续30分钟/);
    assert.throws(() => change(seed(), chat(), 'create', data), /游戏日期与时间/);
    for (const minutes of [0, -1, 1.5, Infinity, 5256001, '30']) assert.throws(() => create(minutes), /持续分钟数/);
});

test('expiry occurs exactly at the deadline and remains visible without a destructive event', () => {
    const state = create(), before = JSON.stringify(state);
    assert.equal(visible(state, advanceClock(clock, 29)).timingStatus.remainingMinutes, 1);
    assert.match(compile(state, chat(), advanceClock(clock, 29)), /防护/);
    assert.equal(visible(state, advanceClock(clock, 30)).timingStatus.state, 'expired');
    assert.equal(compile(state, chat(), advanceClock(clock, 30)), '');
    assert.equal(activeEffects(state, chat()).length, 1);
    assert.equal(JSON.stringify(state), before);
});

test('missing or backwards game time suppresses timed prompt without wallclock substitution', () => {
    const state = create();
    assert.equal(visible(state, null).timingStatus.state, 'unknown');
    assert.equal(compile(state, chat()), '');
    const before = { ...clock, minute: 39 };
    assert.equal(visible(state, before).timingStatus.state, 'unknown');
    assert.throws(() => change(state, chat(), 'pause', { id: visible(state).id, paused: true }, { clock: before }), /早于计时片段/);
});

test('pause freezes elapsed time; resume counts only subsequent game minutes', () => {
    let state = create(); const id = visible(state).id;
    state = change(state, chat(), 'pause', { id, paused: true }, { clock: advanceClock(clock, 10) });
    assert.equal(visible(state, advanceClock(clock, 120)).timingStatus.remainingMinutes, 20);
    assert.equal(visible(state, null).timingStatus.state, 'paused');
    assert.equal(compile(state, chat(), advanceClock(clock, 120)), '');
    assert.throws(() => change(state, chat(), 'pause', { id, paused: false }), /游戏日期与时间/);
    assert.throws(() => change(state, chat(), 'pause', { id, paused: false }, { clock: advanceClock(clock, 5) }), /早于暂停时刻/);
    state = change(state, chat(), 'pause', { id, paused: false }, { clock: advanceClock(clock, 120) });
    assert.equal(visible(state, advanceClock(clock, 139)).timingStatus.remainingMinutes, 1);
    assert.equal(visible(state, advanceClock(clock, 140)).timingStatus.state, 'expired');
});

test('expired timers require explicit duration reset rather than a pause toggle revival', () => {
    let state = create(); const effect = visible(state), expiredAt = advanceClock(clock, 30);
    assert.throws(() => change(state, chat(), 'pause', { id: effect.id, paused: true }, { clock: expiredAt }), /已到期/);
    state = change(state, chat(), 'update', { ...data, id: effect.id, durationMinutes: 15 }, { clock: expiredAt });
    assert.equal(visible(state, expiredAt).timingStatus.remainingMinutes, 15);
    assert.equal(visible(state, expiredAt).condition, data.condition);
});

test('normal edits retain exact timing while explicit null removes the timer', () => {
    const state = create(), effect = visible(state);
    const edited = change(state, chat(), 'update', { ...data, id: effect.id, durationMinutes: undefined, command: '新的指令' });
    assert.deepEqual(visible(edited).timing, effect.timing);
    const untimed = change(edited, chat(), 'update', { ...data, id: effect.id, durationMinutes: null });
    assert.equal(visible(untimed).timingStatus.state, 'untimed');
    assert.match(compile(untimed, chat()), /防护/);
});

test('splitting preserves original lifetime, paused duration and direct target semantics', () => {
    let state = change(seed(), chat(), 'create', { ...data, targetMode: 'direct', target: 'ignored' }, { clock });
    const id = visible(state).id;
    state = change(state, chat(), 'pause', { id, paused: true }, { clock: advanceClock(clock, 5) });
    const children = timedEffects(splitEffect(state, chat(), id, [{ scope: '左侧', holder: '甲' }, { scope: '右侧', holder: '乙' }]), chat(), advanceClock(clock, 100));
    assert.equal(children.length, 2);
    for (const effect of children) { assert.equal(effect.target, ''); assert.equal(effect.targetMode, 'direct'); assert.equal(effect.timingStatus.state, 'paused'); assert.equal(effect.timingStatus.remainingMinutes, 25); assert.deepEqual(effect.timing.startedAt, clock); }
});

test('expiry previews are pure, include reactivation and exclude paused effects', () => {
    const state = create(), before = JSON.stringify(state), arrival = advanceClock(clock, 40);
    const preview = expiryPreview(state, chat(), clock, arrival);
    assert.equal(preview.newlyExpired.length, 1);
    assert.equal(preview.newlyExpired[0].name, '防护');
    assert.equal(preview.newlyExpired[0].remainingMinutes, 0);
    assert.equal(expiryPreview(state, chat(), arrival, clock).reactivated.length, 1);
    assert.equal(expiryPreview(state, chat(), clock, null).unknown.length, 1);
    assert.equal(JSON.stringify(state), before);
});

test('timing replay follows exact message candidates and pause events disappear on branch rewind', () => {
    const c = chat(), state = create(30, c), later = [...c, { name: '向导', is_user: false, mes: '暂歇', swipe_id: 0 }];
    const paused = change(state, later, 'pause', { id: visible(state).id, paused: true }, { clock: advanceClock(clock, 10) });
    assert.equal(timedEffects(paused, later, advanceClock(clock, 40))[0].timingStatus.state, 'paused');
    assert.equal(timedEffects(paused, c, advanceClock(clock, 40))[0].timingStatus.state, 'expired');
    assert.equal(timedEffects(paused, [{ ...c[0], swipe_id: 1 }], clock).length, 0);
});

test('action ids cannot repeat after end, delete or restore in the same branch', () => {
    const state = change(seed(), chat(), 'create', { ...data, actionId: 'ability-check:r1' }, { clock });
    const ended = change(state, chat(), 'end', { id: visible(state).id, reason: '解除' });
    assert.throws(() => change(ended, chat(), 'create', { ...data, actionId: 'ability-check:r1' }, { clock }), /已经确认/);
    const restored = restoreEffects(seed(), chat(), snapshotEffects(ended, chat()));
    assert.equal(activeEffects(restored, chat()).length, 0);
    assert.throws(() => change(restored, chat(), 'create', { ...data, actionId: 'ability-check:r1' }, { clock }), /已经确认/);
    assert.doesNotThrow(() => change(ended, [{ mes: '另一条剧情' }], 'create', { ...data, actionId: 'ability-check:r1' }, { clock }));
});

test('save restore rebases explicit effect snapshots at current tail while retaining old history', () => {
    const c = chat(), old = create(), snapshot = snapshotEffects(old, c), later = [...c, { mes: '后来' }];
    let state = change(old, later, 'end', { id: visible(old).id, reason: '解除' });
    state = change(state, later, 'create', { ...data, target: '其他人', durationMinutes: null });
    const restore = restoreEffects(state, later, snapshot, { operationId: 'save-restore-1' });
    assert.equal(restore.events.length, state.events.length + 1);
    assert.deepEqual(activeEffects(restore, later), snapshot.effects);
    assert.deepEqual(activeEffects(restore, c), activeEffects(old, c));
    assert.throws(() => restoreEffects(restore, later, snapshot, { operationId: 'save-restore-1' }), /已经提交/);
    assert.throws(() => validateEffectsSnapshot({ ...snapshot, version: 99 }), /版本不兼容/);
    const bad = structuredClone(snapshot); bad.effects[0].timing.version = 99;
    assert.throws(() => validateEffectsSnapshot(bad), /计时数据版本/);
});

test('restoring before an action makes saved consumed ids authoritative without changing the old branch', () => {
    const initial = seed(), savedBefore = snapshotEffects(initial, chat());
    const used = change(initial, chat(), 'create', { ...data, actionId: 'ability-check:rewind' }, { clock });
    const later = [...chat(), { mes: '读档到发动前状态' }], restored = restoreEffects(used, later, savedBefore);
    assert.deepEqual(consumedActionIds(restored, later), []);
    assert.equal(activeEffects(restored, later).length, 0);
    assert.deepEqual(consumedActionIds(restored, chat()), ['ability-check:rewind']);
    const reapplied = change(restored, later, 'create', { ...data, actionId: 'ability-check:rewind' }, { clock });
    assert.deepEqual(consumedActionIds(reapplied, later), ['ability-check:rewind']);
    assert.throws(() => change(reapplied, later, 'create', { ...data, actionId: 'ability-check:rewind' }, { clock }), /已经确认/);
});

test('service duration mutation captures clock and effects basis so stale forms cannot apply', async () => {
    const f = fixture(), token = f.api.capture();
    setClock(f.ctx, advanceClock(clock, 5));
    await assert.rejects(f.api.mutate(token, 'create', data), /相关资料已变化/);
    await f.api.mutate(f.api.capture(), 'create', data);
    assert.equal(f.api.timedEffects()[0].timingStatus.remainingMinutes, 30);
    assert.deepEqual(f.api.timedEffects()[0].timing.startedAt, advanceClock(clock, 5));
    assert.equal(contextExpiryPreview(f.ctx, advanceClock(clock, 35)).newlyExpired.length, 1);
    f.api.dispose();
});

test('failed effect save retains exactly one mutation, retry only persists and action id stays consumed', async () => {
    const f = fixture(); let writes = 0;
    f.ctx.saveMetadata = async () => { if (++writes === 1) throw Error('disk'); };
    await assert.rejects(f.api.mutate(f.api.capture(), 'create', { ...data, actionId: 'ability-check:once' }), /保存失败/);
    assert.equal(f.api.dirty(), true);
    const after = JSON.stringify(f.ctx.chatMetadata[KEY]);
    await assert.rejects(f.api.mutate(f.api.capture(), 'create', { ...data, target: '另一人' }), /尚未保存/);
    await f.api.retrySave();
    assert.equal(f.api.dirty(), false);
    assert.equal(writes, 2);
    assert.equal(JSON.stringify(f.ctx.chatMetadata[KEY]), after);
    await assert.rejects(f.api.mutate(f.api.capture(), 'create', { ...data, actionId: 'ability-check:once' }), /已经确认/);
    f.api.dispose();
});

test('regenerate and swipe resolve both effect and game clock from the retained chat prefix', async () => {
    const f = fixture(); await f.api.mutate(f.api.capture(), 'create', data);
    f.ctx.chat.push({ name: '向导', is_user: false, mes: '已经过去一小时', swipe_id: 0 });
    setClock(f.ctx, advanceClock(clock, 60));
    assert.equal(currentPrompt(f.ctx), '');
    f.handlers.start('normal'); assert.equal(f.prompts.get(PROMPT_KEY), '');
    f.handlers.start('regenerate'); assert.match(f.prompts.get(PROMPT_KEY), /防护/);
    f.handlers.start('swipe'); assert.match(f.prompts.get(PROMPT_KEY), /防护/);
    f.handlers.end(); assert.equal(f.prompts.get(PROMPT_KEY), '');
    f.api.dispose();
});

test('malformed timing fails closed and does not reset original data', () => {
    const state = create(), effect = activeEffects(state, chat())[0];
    assert.throws(() => timingStatus({ ...effect, paused: true }, clock), /暂停状态与计时记录不一致/);
    state.events[0].effect.timing.version = 99; const before = JSON.stringify(state);
    assert.throws(() => compile(state, chat(), clock), /计时数据版本/);
    assert.equal(JSON.stringify(state), before);
});

test('legacy settings save shares the cross-app write lease and releases it on failure', async () => {
    const f = fixture(), operations = createOperationService(() => f.ctx); let rejectWrite;
    f.ctx.saveMetadata = () => new Promise((resolve, reject) => { rejectWrite = reject; });
    const pending = f.api.save(f.api.capture(), store => ({ ...store, enabled: false }));
    assert.throws(() => operations.stage({ label: '存档预览', patches: [{ path: [SCENE_KEY], value: f.ctx.chatMetadata[SCENE_KEY] }] }), /正在保存/);
    rejectWrite(Error('disk')); await assert.rejects(pending, /disk/);
    assert.equal(f.ctx.chatMetadata[KEY].enabled, true);
    assert.doesNotThrow(() => operations.stage({ label: '存档预览', patches: [{ path: [SCENE_KEY], value: f.ctx.chatMetadata[SCENE_KEY] }] }));
    operations.dispose(); f.api.dispose();
});

test('external confirmed scene update clears stale effects prompt and refreshes subscribers', async () => {
    const f = fixture(); await f.api.mutate(f.api.capture(), 'create', data);
    f.handlers.start('normal'); assert.match(f.prompts.get(PROMPT_KEY), /防护/);
    let refreshes = 0; const unsubscribe = f.api.subscribe(() => refreshes++);
    const after = { ...f.ctx, chatMetadata: structuredClone(f.ctx.chatMetadata) }; setClock(after, advanceClock(clock, 40));
    const operations = createOperationService(() => f.ctx);
    operations.stage({ label: '确认旅行', patches: [{ path: [SCENE_KEY], value: after.chatMetadata[SCENE_KEY] }] });
    await operations.confirm();
    assert.ok(refreshes > 0); assert.equal(f.prompts.get(PROMPT_KEY), ''); assert.equal(f.api.timedEffects()[0].timingStatus.state, 'expired');
    unsubscribe(); operations.dispose(); f.api.dispose();
});

test('native scene time confirmation refreshes expired effect while metadata save is still pending', async () => {
    const f = fixture(); await f.api.mutate(f.api.capture(), 'create', data);
    f.handlers.start('normal'); assert.match(f.prompts.get(PROMPT_KEY), /防护/);
    const scene = createSceneService(() => f.ctx), seen = [];
    const unsubscribe = f.api.subscribe(() => seen.push(f.api.timedEffects()[0].timingStatus.state));
    let finishSave; f.ctx.saveMetadata = () => new Promise(resolve => { finishSave = resolve; });
    scene.stage('advance-time', { minutes: 40, reason: '休息四十分钟' });
    const pending = scene.confirm();
    try {
        assert.ok(seen.includes('expired'), 'time application must notify timed effects before the save resolves');
        assert.equal(f.prompts.get(PROMPT_KEY), '');
        assert.equal(scene.busy(), true);
    } finally { finishSave?.(); await pending; unsubscribe(); scene.dispose(); f.api.dispose(); }
});
