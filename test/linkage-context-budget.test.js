import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataPrompt, buildDataPromptReport, buildUpdateRules } from '../apps/linkage/prompt.js';
import { KEY, MODULES, emptyLinkageState, validateLinkageState } from '../apps/linkage/policy.js';
import { appendSnapshot, emptyStore } from '../apps/characters/model.js';
import * as Journal from '../apps/journal/model.js';

function fixture() {
    const ctx = { chat: [{ is_user: true, name: '玩家', mes: '继续' }], extensionSettings: {}, chatMetadata: { variables: { 状态栏: JSON.stringify({ 版本: 1, 项目: { 角色: { 描述: '正文'.repeat(5000) } } }) } } };
    ctx.chatMetadata[KEY] = { ...emptyLinkageState(), enabled: true, modules: Object.fromEntries(Object.keys(MODULES).map(id => [id, { enabled: false, read: false, write: false }])) };
    ctx.chatMetadata[KEY].modules.status = { enabled: true, read: true, write: false };
    ctx.chatMetadata[KEY].modules.characters = { enabled: true, read: true, write: false };
    ctx.chatMetadata.amin_os_characters_v1 = appendSnapshot(emptyStore(), ctx.chat, { version: 1, characters: [{ id: 'alice', name: '艾琳', kind: 'pc', notes: '', stats: [] }] }, { id: 'seed', at: '2026-09-24T00:00:00.000Z' });
    return ctx;
}
const budget = (ctx, values = {}) => ctx.chatMetadata[KEY].contextBudget = { enabled: true, maxChars: 1800, requiredModules: [], ...values };

test('budget is opt-in and omits entire optional modules within exact output size', () => {
    const ctx = fixture(), original = buildDataPrompt(ctx);
    assert.match(original, /正文/);
    budget(ctx, { enabled: false }); assert.equal(buildDataPrompt(ctx), original);
    budget(ctx);
    const report = buildDataPromptReport(ctx);
    assert.equal(report.error, ''); assert.ok(report.usedChars <= 1800);
    assert.match(report.prompt, /艾琳/); assert.doesNotMatch(report.prompt, /正文|"root": "状态栏"/);
    assert.equal(report.modules.find(row => row.id === 'status').included, false);
    assert.match(report.modules.find(row => row.id === 'status').reason, /超出/);
    const payload = JSON.parse(report.prompt.slice(report.prompt.indexOf('{')));
    assert.deepEqual(Object.keys(payload.modules), ['characters']);
});

test('writable or explicitly pinned modules fail clearly rather than truncate required data', () => {
    const ctx = fixture(); budget(ctx);
    ctx.chatMetadata[KEY].modules.status.write = true;
    const rules = buildUpdateRules(ctx), report = buildDataPromptReport(ctx);
    assert.match(report.error, /必需资料/); assert.equal(report.prompt, '');
    assert.throws(() => buildDataPrompt(ctx), /超过/);
    assert.equal(buildUpdateRules(ctx), rules);
    ctx.chatMetadata[KEY].modules.status.write = false; budget(ctx, { requiredModules: ['status'] });
    assert.throws(() => buildDataPrompt(ctx), /必需资料/);
});

test('fixed inclusion never overrides read permission or external source', () => {
    const ctx = fixture(); budget(ctx, { requiredModules: ['status'] });
    ctx.chatMetadata[KEY].modules.status = { enabled: true, read: false, write: false };
    const report = buildDataPromptReport(ctx);
    assert.equal(report.error, ''); assert.doesNotMatch(report.prompt, /正文/);
    assert.match(report.modules.find(row => row.id === 'status').reason, /读取权限/);
    ctx.chatMetadata[KEY].dataSource = 'external';
    assert.equal(buildDataPrompt(ctx), '');
    assert.ok(buildDataPromptReport(ctx).modules.every(row => !row.included));
});

test('explicitly enabled journal references remain required and hidden text is never measured or leaked', () => {
    const ctx = fixture(); budget(ctx, { maxChars: 4000 });
    const source = Journal.sourceFromRange(ctx.chat, 0, 0);
    let store = Journal.empty();
    store = Journal.change(store, ctx.chat, 'create', { id: 'hidden', kind: 'fact', title: 'PRIVATE_FACT', body: 'SECRET'.repeat(1000), enabled: false, sources: source }, 'hidden-op');
    store = Journal.change(store, ctx.chat, 'create', { id: 'shown', kind: 'fact', title: '公开事实', body: '门已打开', enabled: true, sources: source }, 'shown-op');
    ctx.chatMetadata[Journal.KEY] = store;
    ctx.chatMetadata[KEY].modules.journal = { enabled: true, read: true, write: false };
    const report = buildDataPromptReport(ctx);
    assert.equal(report.error, ''); assert.match(report.prompt, /门已打开/);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FACT|SECRET/);
    assert.equal(report.modules.find(row => row.id === 'journal').required, true);
    assert.ok(report.modules.find(row => row.id === 'journal').chars < 1500);
});

test('budget policy validates finite integer bounds, module IDs and duplicate pins', () => {
    const ctx = fixture();
    for (const invalid of [{ maxChars: 0 }, { maxChars: 1000.5 }, { maxChars: 2000001 }, { requiredModules: ['private'] }, { requiredModules: ['status', 'status'] }, { enabled: 'yes' }]) {
        budget(ctx, invalid); assert.throws(() => validateLinkageState(ctx.chatMetadata[KEY]), /资料预算/);
    }
    budget(ctx); assert.doesNotThrow(() => validateLinkageState(ctx.chatMetadata[KEY]));
});
import * as Scene from '../apps/scene/model.js';

test('scene priority requires exact active scene entity references, never a matching name', () => {
    const ctx = fixture(); budget(ctx, { maxChars: 30000 });
    ctx.chatMetadata[KEY].modules.scene = { enabled: true, read: true, write: false };
    const state = { ...Scene.emptyState(), activeSceneId: 'here', scenes: { here: { id: 'here', name: '当前场景', participants: '艾琳', participantIds: [] } } };
    const saveScene = () => ctx.chatMetadata[Scene.KEY] = Scene.appendEvent(Scene.emptyStore(), ctx.chat, { state, op: 'save-scene', reason: '确认', details: {} }, { eventId: 'scene-seed', at: '2026-09-24T00:00:00.000Z' });
    saveScene();
    assert.doesNotMatch(buildDataPromptReport(ctx).modules.find(row => row.id === 'characters').reason, /明确关联/);
    state.scenes.here.participantIds = ['alice']; saveScene();
    assert.match(buildDataPromptReport(ctx).modules.find(row => row.id === 'characters').reason, /明确关联/);
    ctx.chatMetadata[KEY].modules.characters = { enabled: true, read: false, write: false };
    const report = buildDataPromptReport(ctx);
    assert.equal(report.modules.find(row => row.id === 'characters').included, false);
    assert.doesNotMatch(report.prompt, /"name": "艾琳"/);
});
