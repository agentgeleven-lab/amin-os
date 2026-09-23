import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, emptyState, emptyStore, readCurrentScene, transition, appendEvent, validateState, validateClock, advanceClock, gameTimeMinutes, clockWeekday, scheduleForecast, absencePreview, floorGameTime, assertReferences, currentPrompt } from '../apps/scene/model.js';
import { KEY as PEOPLE, emptyStore as emptyPeople, appendSnapshot } from '../apps/characters/model.js';
import { createSceneService } from '../apps/scene/service.js';
import { adapter } from '../apps/linkage/adapters/scene.js';
import { KEY as LINKAGE, emptyLinkageState } from '../apps/linkage/policy.js';

const at = '2026-09-23T12:00:00.000Z';
const clock = { year: 2026, month: 9, day: 23, hour: 8, minute: 0, calendarLabel: '' };
const schedule = { characterId: 'npc', title: '值班', startMinute: 480, endMinute: 1020, mapId: 'town', nodeId: 'office', weekdays: [], enabled: true, notes: '' };
const message = (mes, swipe = 0) => ({ name: '角色', is_user: false, mes, swipe_id: swipe });
function setup() {
    const ctx = { chat: [], chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'schedule-chat', saveMetadata: async () => {} };
    ctx.chatMetadata[PEOPLE] = appendSnapshot(emptyPeople(), [], { version: 1, characters: [{ id: 'npc', name: '夏尔', kind: 'npc', notes: '', stats: [] }] }, { id: 'people', at });
    ctx.chatMetadata.dynamicMapV1 = { activeMap: 'town', maps: { town: { name: '小镇', currentLocation: 'inn', nodes: { office: { name: '办事处', discovered: true }, inn: { name: '旅馆', discovered: true } } } } };
    let seq = 0;
    const commit = (op, data, options = {}) => {
        const eventId = `scene_event_${++seq}`;
        const result = transition(readCurrentScene(ctx), op, { reason: '剧情确认', ...data }, { at, sceneId: `scene_${seq}`, entryId: `entry_${seq}`, ...options });
        ctx.chatMetadata[KEY] = appendEvent(ctx.chatMetadata[KEY] ?? emptyStore(), ctx.chat, { ...result, op }, { eventId, at });
        return result.state;
    };
    commit('set-time', { clock });
    return { ctx, commit };
}

test('old scene snapshots gain optional defaults without modifying their stored JSON', () => {
    const old = { version: 1, clock, periods: emptyState().periods, scenes: {}, activeSceneId: null, settings: { enabled: true, includeInContext: false } }, before = structuredClone(old);
    const next = validateState(old); assert.deepEqual(next.schedules, []); assert.equal(next.timeRules.shortRest, 60); assert.deepEqual(next.absenceRules, []); assert.deepEqual(old, before);
});
test('custom calendars advance across month/year boundaries with exact minute arithmetic and immutable timestamps', () => {
    const custom = validateClock({ ...clock, year: 1, month: 2, day: 3, hour: 23, minute: 50,
        calendar: { monthLengths: [2, 3], monthNames: ['芽', '雨'], weekDays: ['甲', '乙', '丙'], epochWeekday: 1 } });
    const before = structuredClone(custom), next = advanceClock(custom, 20);
    assert.equal(next.year, 2); assert.equal(next.month, 1); assert.equal(next.day, 1); assert.equal(next.minute, 10); assert.equal(gameTimeMinutes(next) - gameTimeMinutes(custom), 20);
    assert.equal(clockWeekday({ ...custom, year: 1, month: 1, day: 1 }).index, 1); assert.deepEqual(custom, before);
    assert.throws(() => validateClock({ ...custom, month: 1, day: 3 }), /日期/);
    assert.throws(() => validateClock({ ...custom, calendar: { ...custom.calendar, weekDays: [] } }), /每周/);
    assert.equal(gameTimeMinutes({ year: 1970, month: 1, day: 1, hour: 0, minute: 0 }), 0);
});
test('schedule suggestions follow stable IDs and confirmed presence wins without mutating characters or map', () => {
    const f = setup(); f.commit('save-schedule', { schedule }, { entryId: 'work' });
    f.commit('save-scene', { scene: { name: '旅馆', mapId: 'town', nodeId: 'inn', participantIds: ['npc'] }, activate: true }, { sceneId: 'inn' });
    const before = structuredClone(f.ctx.chatMetadata), result = scheduleForecast(f.ctx)[0];
    assert.equal(result.due, true); assert.equal(result.suggested, false); assert.equal(result.conflict, true); assert.equal(result.confirmed.sceneId, 'inn');
    assert.deepEqual(f.ctx.chatMetadata, before);
    f.ctx.chatMetadata[PEOPLE].events[0].snapshot.characters[0].name = '新名字';
    assert.equal(scheduleForecast(f.ctx)[0].characterName, '新名字');
    f.ctx.chatMetadata[PEOPLE].events[0].snapshot.characters = [];
    assert.equal(scheduleForecast(f.ctx)[0].missingCharacter, true); assert.match(scheduleForecast(f.ctx)[0].characterName, /npc/);
    assert.throws(() => assertReferences(f.ctx, 'save-schedule', { schedule }), /人物 ID/);
});
test('overnight recurrence belongs to the start weekday and is not active all day', () => {
    const f = setup(); f.commit('save-schedule', { schedule: { ...schedule, startMinute: 1320, endMinute: 120, weekdays: [3] } }, { entryId: 'night' });
    assert.equal(scheduleForecast(f.ctx, { ...clock, hour: 23 })[0].due, true);
    assert.equal(scheduleForecast(f.ctx, { ...clock, day: 24, hour: 1 })[0].due, true);
    assert.equal(scheduleForecast(f.ctx, { ...clock, day: 24, hour: 23 })[0].due, false);
    assert.equal(scheduleForecast(f.ctx, { ...clock, day: 24, hour: 2 })[0].due, false);
});
test('overlapping schedules at different places are shown as unresolved rather than a chosen destination', () => {
    const f = setup(); f.commit('save-schedule', { schedule }, { entryId: 'work' });
    f.commit('save-schedule', { schedule: { ...schedule, nodeId: 'inn', title: '会客' } }, { entryId: 'meeting' });
    const values = scheduleForecast(f.ctx); assert.ok(values.every(value => value.overlap && !value.suggested));
    assert.equal(f.ctx.chatMetadata.dynamicMapV1.maps.town.currentLocation, 'inn');
});
test('current branch and floor reads exclude later schedule and clock facts', () => {
    const f = setup(); f.ctx.chat.push(message('出门')); f.commit('save-schedule', { schedule }, { entryId: 'work' });
    f.ctx.chat.push(message('交谈')); f.commit('activity', { activity: 'dialogue', count: 2 });
    assert.equal(floorGameTime(f.ctx, 1).clock.minute, 0); assert.equal(floorGameTime(f.ctx, 2).clock.minute, 2);
    const old = { ...f.ctx, chat: [] }; assert.equal(readCurrentScene(old).schedules.length, 0);
    const alternate = { ...f.ctx, chat: [message('出门', 1)] }; assert.equal(readCurrentScene(alternate).schedules.length, 0);
    const before = structuredClone(f.ctx.chatMetadata); floorGameTime(f.ctx, 0); scheduleForecast(f.ctx); assert.deepEqual(f.ctx.chatMetadata, before);
});
test('absence previews never apply changes on read, keep return-time backlog and settle each interval once', () => {
    const f = setup(); f.commit('save-scene', { scene: { name: '旅馆', weather: '晴' }, activate: true }, { sceneId: 'inn' });
    f.commit('save-absence-rule', { rule: { sceneId: 'inn', title: '雨云到达', field: 'weather', value: '雨', intervalMinutes: 60 } }, { entryId: 'rain' });
    assert.equal(absencePreview(readCurrentScene(f.ctx))[0].due, false);
    f.commit('leave-scene', {}); f.commit('advance-time', { minutes: 130 });
    const before = structuredClone(f.ctx.chatMetadata), preview = absencePreview(readCurrentScene(f.ctx))[0];
    assert.equal(preview.due, true); assert.equal(preview.cycles, 2); assert.equal(readCurrentScene(f.ctx).scenes.inn.weather, '晴'); assert.deepEqual(f.ctx.chatMetadata, before);
    f.commit('switch-scene', { sceneId: 'inn' }); f.commit('advance-time', { minutes: 60 });
    assert.equal(absencePreview(readCurrentScene(f.ctx))[0].cycles, 2);
    const state = f.commit('settle-absence', { ruleIds: ['rain'] }); assert.equal(state.scenes.inn.weather, '雨'); assert.equal(absencePreview(state)[0].due, false);
    assert.throws(() => transition(state, 'settle-absence', { ruleIds: ['rain'], reason: '重复确认' }), /尚未到期/);
});
test('absence checks reject conflicting fields and incompatible calendars without changing facts', () => {
    const f = setup(); f.commit('save-scene', { scene: { name: '院子' } }, { sceneId: 'yard' });
    for (const id of ['one', 'two']) f.commit('save-absence-rule', { rule: { sceneId: 'yard', title: id, field: 'notes', value: id, intervalMinutes: 1 } }, { entryId: id });
    f.commit('advance-time', { minutes: 2 }); const state = readCurrentScene(f.ctx);
    assert.throws(() => transition(state, 'settle-absence', { ruleIds: ['one', 'two'], reason: '确认' }), /同一场景字段/);
    const changed = { ...state, clock: validateClock({ ...clock, calendar: { monthLengths: Array(12).fill(30) } }) };
    assert.equal(absencePreview(changed)[0].due, false); assert.match(absencePreview(changed)[0].status, /无法|缺少/);
});
test('service captures referenced entities and persistence retry does not duplicate new schedules', async () => {
    const f = setup(); let count = 0, fail = true;
    const api = createSceneService(() => f.ctx, { createId: () => 'schedule_ui_' + (++count), now: () => at });
    api.stage('save-schedule', { schedule, reason: '确认作息' }); const before = structuredClone(f.ctx.chatMetadata);
    f.ctx.chatMetadata.dynamicMapV1.maps.town.nodes.office.name = '新的办事处';
    await assert.rejects(api.confirm(), /地图资料已变化/); assert.equal(readCurrentScene(f.ctx).schedules.length, 0);
    api.sync(); f.ctx.saveMetadata = async () => { if (fail) throw Error('offline'); };
    api.stage('save-schedule', { schedule, reason: '确认作息' }); await assert.rejects(api.confirm(), /不会再次推进/);
    assert.equal(readCurrentScene(f.ctx).schedules.length, 1); const events = f.ctx.chatMetadata[KEY].events.length;
    fail = false; await api.retrySave(); assert.equal(f.ctx.chatMetadata[KEY].events.length, events); assert.equal(api.dirty(), false);
    assert.equal(before[KEY].events.length + 1, events); api.dispose();
});
test('scene adapter is pure, rejects settings and invalid references, and appends current-branch history', () => {
    const f = setup(), before = structuredClone(f.ctx.chatMetadata);
    const patch = adapter.apply(f.ctx, { action: 'save-schedule', target: 'work', data: schedule, reason: '剧情明确作息' }, { operationId: 'linked_1', now: at });
    assert.deepEqual(f.ctx.chatMetadata, before); assert.equal(patch.patches.length, 1);
    const sandbox = { ...f.ctx, chatMetadata: { ...f.ctx.chatMetadata, [KEY]: patch.patches[0].value } };
    assert.equal(readCurrentScene(sandbox).schedules[0].id, 'work'); assert.deepEqual(patch.patches[0].value.events.at(-1).path, []);
    assert.throws(() => adapter.apply(f.ctx, { action: 'settings', data: {}, reason: '改设置' }, { operationId: 'bad', now: at }), /不支持/);
    assert.throws(() => adapter.apply(f.ctx, { action: 'save-schedule', target: 'bad', data: { ...schedule, nodeId: 'hidden' }, reason: '剧情' }, { operationId: 'bad', now: at }), /地点不存在/);
    assert.throws(() => adapter.apply(f.ctx, { action: 'save-schedule', target: '__proto__', data: schedule, reason: '剧情' }, { operationId: 'bad', now: at }), /ID/);
});
test('native scene injection yields to the unified module policy', () => {
    const f = setup(); f.commit('settings', { enabled: true, includeInContext: true }); assert.match(currentPrompt(f.ctx), /游戏时间/);
    f.ctx.chatMetadata[LINKAGE] = { ...emptyLinkageState(), enabled: true };
    assert.equal(currentPrompt(f.ctx), ''); assert.equal(adapter.read(f.ctx).clock.hour, 8);
});
test('scene adapter reads only module-owned facts and IDs, not protected referenced character or map content', () => {
    const f = setup(); f.commit('save-schedule', { schedule }, { entryId: 'work' });
    f.ctx.chatMetadata[PEOPLE].events[0].snapshot.characters[0].name = '人物保密名称';
    f.ctx.chatMetadata.dynamicMapV1.maps.town.nodes.office.name = '地点保密名称';
    const text = JSON.stringify(adapter.read(f.ctx)); assert.match(text, /npc/); assert.match(text, /office/); assert.doesNotMatch(text, /人物保密名称|地点保密名称/);
});
