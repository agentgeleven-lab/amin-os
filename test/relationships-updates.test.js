import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY as CHARACTERS_KEY, emptyStore as emptyCharacters, appendSnapshot as appendCharacters } from '../apps/characters/model.js';
import { KEY, emptyStore, emptyState, appendSnapshot, readRelationships, transition, validateState, evaluateThresholds, evidenceMatches, buildRestore } from '../apps/relationships/model.js';
import { createRelationshipsService, PROMPT_KEY } from '../apps/relationships/service.js';
import { parseSuggestions } from '../apps/relationships/draft.js';
import { adapter } from '../apps/linkage/adapters/relationships.js';

const at = '2026-09-23T00:00:00.000Z';
const person = id => ({ id, name: id, kind: 'npc', notes: '', stats: [] });
const relationship = (strength = 1, extra = {}) => ({ id: 'r1', fromId: 'alice', toId: 'bob', type: '信任', label: '', notes: '', strength, ...extra });
const rule = (extra = {}) => ({ id: 'trust', relationshipId: 'r1', operator: 'gte', value: 5, message: '可检查是否愿意分享秘密', enabled: true, repeat: 'once', ...extra });
const change = (extra = {}) => ({ module: 'relationships', action: 'save', target: 'r1', data: { fromId: 'alice', toId: 'bob', type: '信任', strength: 6, sources: [1] }, reason: '鲍勃履行了救援承诺，沿用已约定的信任量表。', ...extra });
function fixture({ ai, hooks = false } = {}) {
    let serial = 0, saves = 0;
    const callbacks = new Map(), prompts = new Map();
    const ctx = { chat: [{ name: '玩家', is_user: true, mes: '请求救援' }, { name: '鲍勃', mes: '已经救出了爱丽丝', swipe_id: 0 }], chatMetadata: { untouched: { keep: true } }, characterId: 0, getCurrentChatId: () => 'relations', saveMetadata: async () => { saves++; } };
    if (hooks) {
        ctx.eventTypes = { GENERATION_AFTER_COMMANDS: 'start', CHAT_CHANGED: 'chat' };
        ctx.eventSource = { on: (id, callback) => callbacks.set(id, callback), removeListener: id => callbacks.delete(id) };
        ctx.setExtensionPrompt = (key, value) => prompts.set(key, value);
    }
    ctx.chatMetadata[CHARACTERS_KEY] = appendCharacters(emptyCharacters(), ctx.chat.slice(0, 1), { version: 1, characters: [person('alice'), person('bob'), person('carol')] }, { id: 'people', at });
    ctx.chatMetadata[KEY] = appendSnapshot(emptyStore(), ctx.chat.slice(0, 1), { ...emptyState(), relationships: [relationship()] }, { id: 'initial', at });
    const api = createRelationshipsService(() => ctx, { createId: () => `operation_${++serial}`, now: () => at, ai });
    return { ctx, api, callbacks, prompts, saves: () => saves };
}

test('old snapshots retain shape while new evidence, threshold rules and alerts round-trip with branch restoration', () => {
    assert.deepEqual(validateState(emptyState()), emptyState());
    const f = fixture();
    try {
        let state = transition(readRelationships(f.ctx), 'save-rule', { rule: rule() });
        const before = structuredClone(state);
        state = transition(state, 'save', { relationship: relationship(6) });
        state = evaluateThresholds(before, state, { operationId: 'update', at });
        assert.equal(state.thresholdAlerts.length, 1); assert.deepEqual(validateState(state), state);
        f.ctx.chatMetadata[KEY] = buildRestore(f.ctx, state, { id: 'restored', at });
        assert.equal(readRelationships(f.ctx).thresholdAlerts.length, 1);
        f.ctx.chat[1] = { ...f.ctx.chat[1], mes: '拒绝救援', swipe_id: 1 };
        assert.equal(readRelationships(f.ctx).relationships[0].strength, 1);
        assert.equal(readRelationships(f.ctx).thresholdRules, undefined);
        assert.throws(() => validateState({ ...state, thresholdRules: [rule({ value: NaN })] }), /有限数字/);
        assert.throws(() => validateState({ ...state, thresholdAlerts: [...state.thresholdAlerts, ...state.thresholdAlerts] }), /重复/);
    } finally { f.api.dispose(); }
});

test('thresholds only notify real crossings, once or each crossing, and do not replay satisfied conditions', () => {
    let state = transition({ ...emptyState(), relationships: [relationship(6)] }, 'save-rule', { rule: rule() });
    assert.equal(state.thresholdAlerts, undefined, 'creating a satisfied rule is not a new story event');
    let serial = 0;
    const save = strength => { const before = state; state = evaluateThresholds(before, transition(state, 'save', { relationship: relationship(strength) }), { operationId: `step_${++serial}`, at }); };
    save(7); assert.equal(state.thresholdAlerts, undefined);
    save(1); save(5); assert.equal(state.thresholdAlerts.length, 1);
    const original = state.thresholdAlerts[0]; assert.equal(original.previousStrength, 1); assert.equal(original.strength, 5);
    save(8); save(0); save(6); assert.equal(state.thresholdAlerts.length, 1);
    state = transition(state, 'acknowledge-alert', { id: original.id }); assert.equal(state.thresholdAlerts[0].acknowledged, true);
    state = transition(state, 'save-rule', { rule: rule({ repeat: 'crossing' }) });
    save(0); save(6); assert.equal(state.thresholdAlerts.length, 2);
    save(8); assert.equal(state.thresholdAlerts.length, 2);
    save(0); save(6); assert.equal(state.thresholdAlerts.length, 3);
    state = transition(state, 'save-rule', { rule: rule({ repeat: 'crossing', enabled: false }) });
    save(0); save(6); assert.equal(state.thresholdAlerts.length, 3);
    assert.equal(state.relationships[0].strength, 6); assert.equal(state.relationships.length, 1);
    const withoutStrength = relationship(); delete withoutStrength.strength;
    const unknownBefore = transition({ ...emptyState(), relationships: [withoutStrength] }, 'save-rule', { rule: rule() });
    const knownAfter = evaluateThresholds(unknownBefore, transition(unknownBefore, 'save', { relationship: relationship(6) }), { operationId: 'first_known', at });
    assert.equal(knownAfter.thresholdAlerts, undefined, 'unknown previous strength is not a proved crossing');
});

test('relationship adapter is pure, preserves direction, binds exact source evidence and rejects illegal references or fields', () => {
    const f = fixture();
    try {
        const original = structuredClone(f.ctx.chatMetadata);
        const result = adapter.apply(f.ctx, change(), { operationId: 'linked_change', now: at });
        assert.deepEqual(f.ctx.chatMetadata, original); assert.equal(f.saves(), 0); assert.equal(result.patches.length, 1);
        const shadow = { ...f.ctx, chatMetadata: { ...f.ctx.chatMetadata, [KEY]: result.patches[0].value } };
        const state = readRelationships(shadow); assert.equal(state.relationships.length, 1); assert.equal(state.relationships[0].fromId, 'alice'); assert.equal(state.relationships[0].toId, 'bob');
        assert.equal(state.relationships[0].evidence.origin, 'linkage'); assert.equal(state.relationships[0].evidence.reason, change().reason); assert.equal(evidenceMatches(state.relationships[0].evidence, f.ctx.chat), true);
        assert.equal(evidenceMatches(state.relationships[0].evidence, [...f.ctx.chat.slice(0, 1), { ...f.ctx.chat[1], swipe_id: 1 }]), false);
        for (const invalid of [change({ target: '__proto__' }), change({ data: { ...change().data, toId: 'not_a_character' } }), change({ data: { ...change().data, sources: [7] } }), change({ data: { ...change().data, settings: {} } }), change({ reason: '' }), change({ action: 'settings' })]) {
            assert.throws(() => adapter.apply(f.ctx, invalid, { operationId: 'invalid', now: at }));
        }
        const renamed = structuredClone(f.ctx.chatMetadata[CHARACTERS_KEY]); renamed.events[0].snapshot.characters[1].name = '改名的鲍勃'; f.ctx.chatMetadata[CHARACTERS_KEY] = renamed;
        assert.equal(adapter.apply(f.ctx, change(), { operationId: 'same_person', now: at }).patches[0].value.events.at(-1).snapshot.relationships[0].toId, 'bob');
    } finally { f.api.dispose(); }
});

test('adapter rule operations and deletion keep historical evidence and reject changing an unresolved rule to another missing relation', () => {
    const f = fixture();
    try {
        const apply = (action, target, data, id) => { const value = adapter.apply(f.ctx, { module: 'relationships', action, target, data, reason: '用户确认的规则调整' }, { operationId: id, now: at }); f.ctx.chatMetadata[KEY] = value.patches[0].value; };
        const { id: unused, ...data } = rule(); apply('save-rule', 'trust', data, 'rule_added');
        apply('save', 'r1', change().data, 'relation_updated'); assert.equal(readRelationships(f.ctx).thresholdAlerts.length, 1);
        const alert = readRelationships(f.ctx).thresholdAlerts[0]; apply('acknowledge-alert', alert.id, {}, 'read_alert');
        apply('delete', 'r1', {}, 'removed_relation');
        assert.equal(readRelationships(f.ctx).relationships.length, 0); assert.equal(readRelationships(f.ctx).thresholdRules.length, 1); assert.equal(readRelationships(f.ctx).thresholdAlerts[0].acknowledged, true);
        assert.equal(f.ctx.chatMetadata[KEY].events.at(-1).evidence.reason, '用户确认的规则调整');
        assert.throws(() => apply('save-rule', 'trust', { ...data, relationshipId: 'missing' }, 'invalid_rule'), /当前已有/);
        apply('delete-rule', 'trust', {}, 'removed_rule'); assert.equal(readRelationships(f.ctx).thresholdRules.length, 0); assert.equal(readRelationships(f.ctx).thresholdAlerts.length, 1);
    } finally { f.api.dispose(); }
});

test('AI proposals use captured relationship channel and chosen story only, then require one batch confirmation', async () => {
    const calls = [];
    const reverse = change({ target: 'r2', data: { fromId: 'bob', toId: 'alice', type: '同伴', sources: [1] }, reason: '鲍勃明确认可同伴关系。' });
    const ai = { capture: app => { calls.push(['capture', app]); return { frozen: true }; }, generate: async (...args) => { calls.push(args); return JSON.stringify({ version: 1, changes: [change(), reverse] }); } };
    const f = fixture({ ai });
    try {
        const original = structuredClone(f.ctx.chatMetadata);
        await f.api.suggestUpdates({ start: 1, end: 1, instruction: '仅记录已明确发生的变化' });
        assert.deepEqual(f.ctx.chatMetadata, original); assert.equal(f.saves(), 0); assert.equal(f.api.preview().changes.length, 2);
        assert.deepEqual(calls[0], ['capture', 'relationships']); assert.equal(calls[1][0], '人物关系 · 剧情更新');
        const prompt = JSON.parse(calls[1][2].prompt); assert.deepEqual(prompt.sources.map(source => source.index), [1]); assert.equal(prompt.characters[0].id, 'alice');
        assert.equal(calls[1][3].includeLinkage, false); assert.deepEqual(calls[1][3].snapshot, { frozen: true });
        await f.api.confirm(); assert.equal(f.saves(), 1); assert.equal(readRelationships(f.ctx).relationships.length, 2); assert.equal(f.ctx.chatMetadata[KEY].events.length, 3);
        assert.equal(readRelationships(f.ctx).relationships[0].evidence.origin, 'ai'); assert.deepEqual(f.ctx.chatMetadata.untouched, { keep: true });
    } finally { f.api.dispose(); }
});

test('an invalid final AI proposal rejects the whole batch without a partial preview or metadata mutation', async () => {
    const bad = change({ target: 'r2', data: { ...change().data, toId: 'unknown' } });
    const f = fixture({ ai: { capture: () => ({}), generate: async () => JSON.stringify({ version: 1, changes: [change(), bad] }) } });
    try {
        const original = structuredClone(f.ctx.chatMetadata);
        await assert.rejects(f.api.suggestUpdates({ start: 1, end: 1 }), /当前人物/);
        assert.deepEqual(f.ctx.chatMetadata, original); assert.equal(f.api.preview(), null); assert.equal(f.saves(), 0);
        f.api.saveThresholdRule(rule()); await f.api.confirm();
        f.api.stageSuggestions([change()], f.api.capture(), [1]); f.ctx.saveMetadata = async () => { throw Error('offline'); };
        await assert.rejects(f.api.confirm(), /保存失败/); const events = structuredClone(f.ctx.chatMetadata[KEY]);
        assert.equal(readRelationships(f.ctx).thresholdAlerts.length, 1);
        f.ctx.saveMetadata = async () => {}; await f.api.retrySave(); await f.api.retrySave(); assert.deepEqual(f.ctx.chatMetadata[KEY], events);
    } finally { f.api.dispose(); }
});

test('AI changes cannot cite unselected floors, configure thresholds or survive a changed source candidate', async () => {
    assert.throws(() => parseSuggestions(JSON.stringify({ version: 1, changes: [change({ action: 'save-rule' })] })), /只能包含/);
    assert.throws(() => parseSuggestions(JSON.stringify({ version: 1, changes: [change(), change()] })), /同一关系/);
    let release;
    const f = fixture({ ai: { capture: () => ({}), generate: () => new Promise(resolve => { release = resolve; }) } });
    try {
        assert.throws(() => f.api.stageSuggestions([change()], f.api.capture(), [0]), /来源超出/);
        const { sources: unused, ...noSource } = change().data;
        assert.throws(() => f.api.stageSuggestions([change({ data: noSource })], f.api.capture(), [1]), /明确提供来源/);
        const waiting = f.api.suggestUpdates({ start: 1, end: 1 });
        f.ctx.chat[1].swipe_id = 1; f.api.sync(); release(JSON.stringify({ version: 1, changes: [change()] }));
        await assert.rejects(waiting, /已变化|取消/); assert.equal(f.api.preview(), null); assert.equal(f.saves(), 0);
    } finally { f.api.dispose(); }
});

test('active unified relationship policy suppresses legacy prompt even when its old read toggle remains enabled', async () => {
    const f = fixture({ hooks: true });
    try {
        f.api.stage('settings', { includeInContext: true }); await f.api.confirm();
        f.callbacks.get('start')('normal'); assert.ok(f.prompts.get(PROMPT_KEY));
        f.ctx.chatMetadata.amin_os_linkage_v1 = { version: 1, enabled: true, mode: 'review', modules: { relationships: { enabled: true, read: false, write: false } }, extraRules: '', applied: [] };
        f.callbacks.get('start')('normal'); assert.equal(f.prompts.get(PROMPT_KEY), ''); assert.equal(f.api.managed(), true);
        f.ctx.chatMetadata.amin_os_linkage_v1.enabled = false;
        f.callbacks.get('start')('normal'); assert.ok(f.prompts.get(PROMPT_KEY));
    } finally { f.api.dispose(); }
});

test('no-change proposals do not create pending operations and malformed JSON does not execute code', async () => {
    assert.deepEqual(parseSuggestions('```json\n{"version":1,"changes":[]}\n```'), []);
    assert.throws(() => parseSuggestions('globalThis.polluted=true'), /JSON/);
    const f = fixture({ ai: { capture: () => ({}), generate: async () => '{"version":1,"changes":[]}' } });
    try { assert.equal(await f.api.suggestUpdates({ start: 1, end: 1 }), null); assert.equal(f.api.preview(), null); assert.equal(f.saves(), 0); }
    finally { f.api.dispose(); }
});
