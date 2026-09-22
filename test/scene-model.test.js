import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, emptyState, emptyStore, transition, appendEvent, readCurrentScene, currentPrompt, advanceClock, validateClock, parsePeriods, formatGameTime, mapReferences, createSceneId } from '../apps/scene/model.js';
const clock = (override = {}) => ({ year: 2024, month: 2, day: 28, hour: 23, minute: 55, calendarLabel: '调查历', ...override });
const message = (mes, swipe = 0) => ({ name: '调查员', is_user: false, mes, swipe_id: swipe });
const at = '2026-09-23T01:00:00.000Z';
test('scene IDs use secure getRandomValues when HTTP browsers lack randomUUID', () => {
    let called = 0;
    const value = createSceneId({ getRandomValues(bytes) { called++; bytes.fill(17); return bytes; } });
    assert.equal(value, '11111111-1111-4111-9111-111111111111'); assert.equal(called, 1);
    assert.throws(() => createSceneId({}), /安全随机数/);
});
function commit(ctx, op, data, id) {
    const result = transition(readCurrentScene(ctx), op, { ...data, reason: data.reason ?? '测试确认' }, { at, sceneId: 'scene_' + id });
    ctx.chatMetadata[KEY] = appendEvent(ctx.chatMetadata[KEY] ?? emptyStore(), ctx.chat, { ...result, op }, { at, eventId: 'event_' + id });
    return readCurrentScene(ctx);
}
test('clock advances with leap day, month, year and low year boundaries independent of local timezone', () => {
    assert.deepEqual(advanceClock(clock(), 10), clock({ day: 29, hour: 0, minute: 5 }));
    assert.deepEqual(advanceClock(clock({ day: 29 }), 10), clock({ month: 3, day: 1, hour: 0, minute: 5 }));
    assert.deepEqual(advanceClock(clock({ year: 2023, month: 12, day: 31 }), 10), clock({ month: 1, day: 1, hour: 0, minute: 5 }));
    assert.equal(advanceClock(clock({ year: 4 }), 10).day, 29);
    assert.throws(() => validateClock(clock({ year: 2023, day: 29 })), /不存在/);
    assert.throws(() => advanceClock(clock({ year: 9999, month: 12, day: 31 }), 10), /年份/);
    assert.throws(() => advanceClock(clock(), -1), /推进分钟数/);
    assert.throws(() => advanceClock(clock(), 0.5), /整数/);
});
test('day periods are explicit editable labels and must cover midnight', () => {
    const periods = parsePeriods('12:00 白昼\n00:00 宵禁');
    assert.equal(formatGameTime(clock({ hour: 1 }), periods), '调查历 2024-02-28 01:55 · 宵禁');
    assert.throws(() => parsePeriods('06:00 清晨'), /00:00/);
    assert.throws(() => parsePeriods('00:00 深夜\n00:00 午夜'), /重复/);
    assert.throws(() => parsePeriods('24:00 午夜'), /每行/);
});
test('opening or reading an empty chat creates neither metadata nor story facts', () => {
    const ctx = { chat: [], chatMetadata: {} }, before = structuredClone(ctx);
    assert.deepEqual(readCurrentScene(ctx), emptyState()); assert.equal(currentPrompt(ctx), '');
    assert.deepEqual(ctx, before);
});
test('explicit initial state is available to descendants, later branch copies exclude future state', () => {
    const ctx = { chat: [], chatMetadata: {} };
    commit(ctx, 'set-time', { clock: clock() }, 'start');
    ctx.chat.push(message('调查前厅')); commit(ctx, 'advance-time', { minutes: 60 }, 'advance');
    const fork = { chat: [], chatMetadata: structuredClone(ctx.chatMetadata) };
    assert.deepEqual(readCurrentScene(fork).clock, clock());
    assert.deepEqual(readCurrentScene(ctx).clock, advanceClock(clock(), 60));
    assert.equal(ctx.chat[0].extra, undefined);
});
test('edited text, middle deletion and alternate candidate cannot leak future snapshots', () => {
    const ctx = { chat: [message('开场')], chatMetadata: {} };
    commit(ctx, 'set-time', { clock: clock() }, 'initial');
    ctx.chat.push(message('走入地下室')); commit(ctx, 'advance-time', { minutes: 10 }, 'after');
    const meta = structuredClone(ctx.chatMetadata);
    assert.deepEqual(readCurrentScene({ chat: [message('开场'), message('走入地下室', 1)], chatMetadata: meta }).clock, clock());
    assert.deepEqual(readCurrentScene({ chat: [message('开场'), message('走入花园')], chatMetadata: meta }).clock, clock());
    assert.equal(readCurrentScene({ chat: [message('走入地下室')], chatMetadata: meta }).clock, null);
    assert.equal(readCurrentScene({ chat: [message('改写开场')], chatMetadata: meta }).clock, null);
});
test('returning to an old candidate restores its snapshot even after reload', () => {
    const ctx = { chat: [message('开场')], chatMetadata: {} }; commit(ctx, 'set-time', { clock: clock() }, 'base');
    ctx.chat.push(message('第一候选')); commit(ctx, 'advance-time', { minutes: 60 }, 'a');
    ctx.chat[1] = message('第二候选', 1); assert.deepEqual(readCurrentScene(ctx).clock, clock());
    commit(ctx, 'advance-time', { minutes: 10 }, 'b');
    const loaded = { chat: [message('开场'), message('第一候选')], chatMetadata: structuredClone(ctx.chatMetadata) };
    assert.deepEqual(readCurrentScene(loaded).clock, advanceClock(clock(), 60));
});
test('scene return restores saved facts but never rewinds the global story clock', () => {
    const ctx = { chat: [], chatMetadata: {} }; commit(ctx, 'set-time', { clock: clock() }, 'start');
    commit(ctx, 'save-scene', { scene: { name: '客厅', objects: '窗户关闭' }, activate: true }, 'living');
    commit(ctx, 'save-scene', { scene: { name: '花园', weather: '雨' } }, 'garden');
    commit(ctx, 'switch-scene', { sceneId: 'scene_garden' }, 'enter');
    commit(ctx, 'advance-time', { minutes: 480 }, 'rest');
    const state = commit(ctx, 'switch-scene', { sceneId: 'scene_living' }, 'return');
    assert.equal(state.scenes[state.activeSceneId].objects, '窗户关闭');
    assert.deepEqual(state.clock, advanceClock(clock(), 480));
    assert.deepEqual(state.scenes.scene_garden.gameTime, state.clock);
    assert.deepEqual(state.scenes.scene_living.gameTime, state.clock);
});
test('only explicit saved current facts enter context after opt in', () => {
    const ctx = { chat: [], chatMetadata: {} };
    commit(ctx, 'save-scene', { scene: { name: '客厅', objects: '窗户关闭' }, activate: true }, 'living');
    commit(ctx, 'save-scene', { scene: { name: '秘密地牢', notes: '未进入处的资料' } }, 'secret');
    assert.equal(currentPrompt(ctx), '');
    commit(ctx, 'settings', { enabled: true, includeInContext: true }, 'enable');
    const prompt = currentPrompt(ctx); assert.match(prompt, /客厅/); assert.match(prompt, /窗户关闭/);
    assert.doesNotMatch(prompt, /秘密地牢|未进入处的资料|游戏时间":/);
    commit(ctx, 'settings', { enabled: false, includeInContext: true }, 'disable'); assert.equal(currentPrompt(ctx), '');
});
test('scene IDs and versions are validated without changing existing data', () => {
    const ctx = { chat: [], chatMetadata: { [KEY]: { version: 999, events: [] } } }, before = structuredClone(ctx);
    assert.throws(() => readCurrentScene(ctx), /不兼容/); assert.deepEqual(ctx, before);
    assert.throws(() => transition(emptyState(), 'save-scene', { scene: { id: 'missing', name: '未授权' }, reason: '测试' }), /不在当前/);
});
test('map references expose discovered stable IDs read-only, never demo or hidden locations', () => {
    const ctx = { chatMetadata: { dynamicMapV1: { activeMap: 'map_a', maps: { map_a: { name: '街区', currentLocation: 'node_a', nodes: { node_a: { name: '车站', discovered: true }, secret: { name: '秘道', discovered: false } } } } } } };
    const before = structuredClone(ctx), refs = mapReferences(ctx);
    assert.deepEqual(refs, [{ mapId: 'map_a', nodeId: 'node_a', mapName: '街区', nodeName: '车站', current: true }]); assert.deepEqual(ctx, before);
    assert.deepEqual(mapReferences({ chatMetadata: {} }), []);
});
