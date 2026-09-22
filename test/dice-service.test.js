import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiceService, createRollId, HISTORY_KEY, SETTINGS_KEY, appendText, appendToDraft } from '../apps/dice/service.js';
function host() {
    const handlers = new Map(), events = ['MESSAGE_SENT', 'CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED'];
    let saves = 0, id = 0, rolls = 0;
    const ctx = { chatId: 'a', chat: [], chatMetadata: {}, extensionSettings: {}, saveMetadata: async () => { saves++; }, saveSettingsDebounced: async () => {}, eventTypes: Object.fromEntries(events.map(v => [v, v])), eventSource: { on: (n, fn) => handlers.set(n, fn), removeListener: n => handlers.delete(n) } };
    const api = createDiceService(() => ctx, { rng: () => { rolls++; return 4; }, createId: () => 'roll-' + String(++id).padStart(12, '0'), now: () => 12345 });
    return { api, ctx, handlers, saves: () => saves, rolls: () => rolls };
}
function input(value = '') { return { value, emitted: 0, dispatchEvent() { this.emitted++; }, focus() {} }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('LAN browser IDs use secure random bytes when randomUUID is unavailable', () => {
    let calls = 0;
    const id = createRollId({ getRandomValues(bytes) { calls++; bytes.fill(255); } });
    assert.equal(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff'); assert.equal(calls, 1);
    assert.throws(() => createRollId({}), /安全随机/);
});
test('roll snapshots settings; append preserves the complete draft and never invokes a send API', async () => {
    const h = host(), settings = { formula: '2d6+1', label: '攻击' }, r = await h.api.roll(settings); settings.formula = 'd20';
    assert.equal(h.api.history()[0].settings.formula, '2d6+1'); assert.equal(r.results[0].total, 9);
    const draft = input('我攻击。\n  保留空格  '); await h.api.append(r.id, draft);
    assert.equal(draft.value, '我攻击。\n  保留空格  \n' + r.text); assert.equal(draft.emitted, 1); assert.equal(h.ctx.chat.length, 0); assert.equal(h.rolls(), 2);
    await assert.rejects(h.api.append(r.id, draft), /已经在草稿/);
    await h.api.undoAppend(); assert.equal(draft.value, '我攻击。\n  保留空格  '); assert.equal(h.api.history()[0].status, 'rolled');
});
test('manual edits block undo; asynchronous save and chat guards do not overwrite newer drafts', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('原稿'); await h.api.append(r.id, draft); draft.value += ' 新编辑';
    await assert.rejects(h.api.undoAppend(), /编辑草稿/); assert.ok(draft.value.endsWith(' 新编辑'));
    const token = h.api.capture(); h.ctx.chatId = 'b'; h.ctx.chatMetadata = {}; assert.throws(() => h.api.check(token), /聊天已变化/); await assert.rejects(h.api.append(r.id, draft), /不存在/);
    assert.equal(h.api.history().length, 0); h.api.dispose();
});
test('metadata replacement under same chat id invalidates old append handles', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('文本'); await h.api.append(r.id, draft);
    h.ctx.chatMetadata = structuredClone(h.ctx.chatMetadata);
    await assert.rejects(h.api.undoAppend(), /聊天已变化/); assert.ok(draft.value.includes(r.text));
});
test('fixed results survive save failure; retrySave consumes no more random numbers', async () => {
    const h = host(); h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(h.api.roll({ formula: '2d6' }), /已固定/); const record = h.api.history()[0]; assert.equal(record.results[0].total, 8); assert.equal(h.api.dirty(), true); assert.equal(h.rolls(), 2);
    const draft = input('正文'); await assert.rejects(h.api.append(record.id, draft), /保存失败/); assert.equal(draft.value, '正文');
    h.ctx.saveMetadata = async () => {}; await h.api.retrySave(); assert.equal(h.api.dirty(), false); assert.equal(h.rolls(), 2); await h.api.append(record.id, draft); assert.ok(draft.value.includes(record.text));
});
test('editing a draft during pending retry does not replace or append to it', async () => {
    const h = host(); h.ctx.saveMetadata = async () => { throw Error('fail'); }; await assert.rejects(h.api.roll({ formula: 'd6' }));
    let release; h.ctx.saveMetadata = () => new Promise(resolve => { release = resolve; }); const draft = input('旧草稿'), record = h.api.history()[0], pending = h.api.append(record.id, draft);
    draft.value = '我的新草稿'; release(); await assert.rejects(pending, /草稿已改变/); assert.equal(draft.value, '我的新草稿'); assert.equal(h.api.history()[0].status, 'rolled');
});
test('send binding requires a new matching user message; generation and old assistant text do nothing', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('行动'); await h.api.append(r.id, draft);
    h.ctx.chat.push({ is_user: false, mes: draft.value }); h.handlers.get('MESSAGE_SENT')(0); await tick(); assert.equal(h.api.history()[0].status, 'appended');
    h.ctx.chat.push({ is_user: true, mes: draft.value }); const before = structuredClone(h.ctx.chat); h.handlers.get('MESSAGE_SENT')(1); await tick();
    assert.equal(h.api.history()[0].status, 'sent'); assert.equal(h.api.history()[0].sent.messageIndex, 1); assert.equal(h.api.history()[0].linked, true); assert.deepEqual(h.ctx.chat, before); assert.equal(h.rolls(), 1);
    h.ctx.chat[1].mes += ' edited'; assert.equal(h.api.history()[0].linked, false); h.handlers.get('MESSAGE_SWIPED')(); assert.equal(h.rolls(), 1);
    await assert.rejects(h.api.append(r.id, input('')), /已发出/);
});
test('chat switching clears transient pending markers and history stays isolated', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), oldMeta = h.ctx.chatMetadata, draft = input('行动'); await h.api.append(r.id, draft);
    h.ctx.chatId = 'b'; h.ctx.chatMetadata = {}; h.ctx.chat = [{ is_user: true, mes: draft.value }]; h.handlers.get('CHAT_CHANGED')(); h.handlers.get('MESSAGE_SENT')(0);
    await tick(); assert.equal(h.api.history().length, 0); assert.equal(oldMeta[HISTORY_KEY].rolls[0].status, 'appended');
    h.ctx.chatId = 'a'; h.ctx.chatMetadata = oldMeta; assert.equal(h.api.history().length, 1);
});
test('explicit reroll creates a new fixed result linked to original; presets are global settings only', async () => {
    const h = host(), original = await h.api.roll({ mode: 'dnd', modifier: 3 }), next = await h.api.reroll(original.id); assert.notEqual(next.id, original.id); assert.equal(next.rerollOf, original.id);
    const preset = await h.api.savePreset('潜行', original.settings); assert.equal(h.ctx.extensionSettings[SETTINGS_KEY].presets.length, 1);
    const history = structuredClone(h.ctx.chatMetadata); h.ctx.chatId = 'b'; h.ctx.chatMetadata = {}; assert.equal(h.api.presets()[0].id, preset.id); assert.equal(h.api.history().length, 0);
    await assert.rejects(h.api.savePreset('潜行', original.settings), /同名/); await h.api.deletePreset(preset.id); assert.equal(h.api.presets().length, 0); assert.equal(history[HISTORY_KEY].rolls.length, 2);
});
test('preset persistence failure rolls back exactly the original setting and disposal removes listeners', async () => {
    const h = host(); h.ctx.saveSettingsDebounced = async () => { throw Error('offline'); };
    await assert.rejects(h.api.savePreset('伤害', { formula: 'd6' }), /保存失败/); assert.equal(h.ctx.extensionSettings[SETTINGS_KEY], undefined); assert.equal(h.api.presets().length, 0);
    h.api.dispose(); assert.equal(h.handlers.size, 0);
});
test('pure draft append refuses stale drafts, disabled inputs, duplicates and chat invalidation', () => {
    assert.equal(appendText('a\n', 'b'), 'a\nb'); const draft = input('manual');
    assert.throws(() => appendToDraft({ input: draft, text: 'roll', expectedDraft: 'old', check() {} }), /草稿已改变/); assert.equal(draft.value, 'manual');
    assert.throws(() => appendToDraft({ input: draft, text: 'roll', expectedDraft: 'manual', check() { throw Error('chat changed'); } }), /chat changed/);
    draft.disabled = true; assert.throws(() => appendToDraft({ input: draft, text: 'roll', expectedDraft: 'manual', check() {} }), /不可编辑/);
});
test('history never silently drops old records after the display page boundary', async () => {
    const h = host(), initial = await h.api.roll({ formula: 'd6' });
    h.ctx.chatMetadata[HISTORY_KEY].rolls = Array.from({ length: 250 }, (_, i) => ({ ...structuredClone(initial), id: 'old-' + i }));
    await h.api.roll({ formula: 'd20' });
    assert.equal(h.api.history().length, 251); assert.equal(h.api.history()[0].id, 'old-0');
    assert.equal(h.ctx.chatMetadata[HISTORY_KEY].rolls.length, 251);
});
test('ambiguous new user messages and manually changed blocks are not marked as sent', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('行动'); await h.api.append(r.id, draft);
    h.ctx.chat.push({ is_user: true, mes: draft.value }, { is_user: true, mes: draft.value });
    h.handlers.get('MESSAGE_SENT')(); await tick(); assert.equal(h.api.history()[0].status, 'appended');
    h.ctx.chat = [{ is_user: true, mes: draft.value.replace('= 4', '= 20') }];
    h.handlers.get('MESSAGE_SENT')(0); await tick(); assert.equal(h.api.history()[0].status, 'appended');
});
test('chat switch during delayed save cannot append an old roll to the new chat draft', async () => {
    const h = host(); h.ctx.saveMetadata = async () => { throw Error('fail'); }; await assert.rejects(h.api.roll({ formula: 'd6' }));
    let release; h.ctx.saveMetadata = () => new Promise(resolve => { release = resolve; });
    const draft = input('旧草稿'), record = h.api.history()[0], append = h.api.append(record.id, draft);
    h.ctx.chatId = 'new'; h.ctx.chatMetadata = {}; draft.value = '新聊天草稿'; release();
    await assert.rejects(append, /聊天已变化/); assert.equal(draft.value, '新聊天草稿'); assert.equal(h.api.history().length, 0);
});
test('a pending append merges the latest sent states after awaiting retry-save', async () => {
    const h = host(), a = await h.api.roll({ formula: 'd6', label: 'A' }), inputA = input('行动A'); await h.api.append(a.id, inputA);
    h.ctx.saveMetadata = async () => { throw Error('fail'); }; await assert.rejects(h.api.roll({ formula: 'd20', label: 'B' }));
    const b = h.api.history()[1], inputB = input('行动B'); let release, calls = 0;
    h.ctx.saveMetadata = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    const appendB = h.api.append(b.id, inputB);
    h.ctx.chat.push({ is_user: true, mes: inputA.value }); h.handlers.get('MESSAGE_SENT')(0); await tick();
    assert.equal(h.api.history()[0].status, 'sent'); release(); await appendB;
    assert.equal(h.api.history()[0].status, 'sent'); assert.equal(h.api.history()[1].status, 'appended');
    assert.ok(inputB.value.includes(b.text));
});
test('reloading the service restores persisted append boundaries only in the same chat', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('行动'); await h.api.append(r.id, draft);
    h.api.dispose(); const replacement = createDiceService(() => h.ctx);
    h.ctx.chat.push({ is_user: true, mes: draft.value }); h.handlers.get('MESSAGE_SENT')(0); await tick();
    assert.equal(replacement.history()[0].status, 'sent'); assert.equal(replacement.history()[0].linked, true);
    await assert.rejects(replacement.append(r.id, input('')), /已发出/); replacement.dispose();
});
test('a copied branch cannot restore another chat pending boundary', async () => {
    const h = host(), r = await h.api.roll({ formula: 'd6' }), draft = input('行动'); await h.api.append(r.id, draft);
    h.ctx.chatId = 'branch'; h.ctx.chatMetadata = structuredClone(h.ctx.chatMetadata); h.handlers.get('CHAT_CHANGED')();
    h.ctx.chat.push({ is_user: true, mes: draft.value }); h.handlers.get('MESSAGE_SENT')(0); await tick();
    assert.equal(h.api.history()[0].status, 'appended'); h.api.dispose();
});
test('unknown history versions and damaged raw entries are preserved before any new roll', async () => {
    const h = host(), existing = await h.api.roll({ formula: 'd6' });
    for (const source of [
        { version: 99, rolls: [existing, { unknown: true }], extraField: { keep: true } },
        { version: 1, rolls: [existing, { unknown: true }], extraField: { keep: true } },
        { version: 1, rolls: 'damaged', extraField: { keep: true } },
        { version: 1, rolls: [existing, structuredClone(existing)] },
    ]) {
        h.ctx.chatMetadata[HISTORY_KEY] = structuredClone(source); const before = structuredClone(h.ctx.chatMetadata), draws = h.rolls(), saves = h.saves();
        await assert.rejects(h.api.roll({ formula: 'd20' }), /原始数据已保留/);
        await assert.rejects(h.api.retrySave(), /原始数据已保留/);
        assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(h.rolls(), draws); assert.equal(h.saves(), saves); assert.equal(h.api.busy(), false);
    }
});
test('append, undo and sent-state writes reject incompatible raw history without losing data', async () => {
    const h = host(), record = await h.api.roll({ formula: 'd6' }), draft = input('行动'); await h.api.append(record.id, draft);
    h.ctx.chatMetadata[HISTORY_KEY].rolls.push({ futureFormat: true }); const before = structuredClone(h.ctx.chatMetadata), text = draft.value, saves = h.saves();
    await assert.rejects(h.api.append(record.id, input('别的正文')), /原始数据已保留/);
    await assert.rejects(h.api.undoAppend(), /原始数据已保留/);
    h.ctx.chat.push({ is_user: true, mes: text });
    assert.doesNotThrow(() => h.handlers.get('MESSAGE_SENT')(0)); await tick();
    assert.deepEqual(h.ctx.chatMetadata, before); assert.equal(draft.value, text); assert.equal(h.saves(), saves); assert.match(h.api.status(), /原始数据已保留/);
});
test('normal and legacy history shapes keep document and record extension fields on writes', async () => {
    const h = host(), initial = await h.api.roll({ formula: 'd6' });
    h.ctx.chatMetadata[HISTORY_KEY].extraField = { preserve: ['all'] }; h.ctx.chatMetadata[HISTORY_KEY].rolls[0].extensionField = { keep: true };
    delete h.ctx.chatMetadata[HISTORY_KEY].version; delete h.ctx.chatMetadata[HISTORY_KEY].rolls[0].status;
    const next = await h.api.roll({ formula: 'd20' }); await h.api.append(next.id, input('行动'));
    assert.deepEqual(h.ctx.chatMetadata[HISTORY_KEY].extraField, { preserve: ['all'] });
    assert.deepEqual(h.ctx.chatMetadata[HISTORY_KEY].rolls.find(r => r.id === initial.id).extensionField, { keep: true });
    assert.equal(h.ctx.chatMetadata[HISTORY_KEY].version, 1); assert.equal(h.ctx.chatMetadata[HISTORY_KEY].rolls.length, 2);
});
test('preset saves and deletes reject unknown schema and corrupt raw records without pruning', async () => {
    const h = host(), valid = { id: 'valid', name: '原预设', settings: { formula: 'd6' }, extensionField: 'preserve' };
    for (const source of [
        { version: 99, presets: [valid], extraField: 'keep' },
        { version: 1, presets: [valid, { unknown: true }], extraField: 'keep' },
        { version: 1, presets: null, extraField: 'keep' },
    ]) {
        h.ctx.extensionSettings[SETTINGS_KEY] = structuredClone(source); const before = structuredClone(h.ctx.extensionSettings);
        await assert.rejects(h.api.savePreset('新预设', { formula: 'd20' }), /原始数据已保留/);
        await assert.rejects(h.api.deletePreset('valid'), /原始数据已保留/);
        assert.deepEqual(h.ctx.extensionSettings, before); assert.equal(h.api.busy(), false);
    }
});
test('preset updates and deletes preserve unknown fields on compatible source records', async () => {
    const h = host();
    h.ctx.extensionSettings[SETTINGS_KEY] = { version: 1, extraField: 'document', presets: [
        { id: 'a', name: '旧A', settings: { formula: 'd6', extensionSetting: 'keep' }, extensionField: 'record-A' },
        { id: 'b', name: '旧B', settings: { formula: 'd8' }, extensionField: 'record-B' },
    ] };
    await h.api.savePreset('新A', { formula: 'd20' }, 'a');
    let stored = h.ctx.extensionSettings[SETTINGS_KEY]; assert.equal(stored.extraField, 'document'); assert.equal(stored.presets[0].extensionField, 'record-A'); assert.equal(stored.presets[0].settings.extensionSetting, 'keep'); assert.equal(stored.presets[1].extensionField, 'record-B');
    await h.api.deletePreset('a'); stored = h.ctx.extensionSettings[SETTINGS_KEY]; assert.equal(stored.extraField, 'document'); assert.equal(stored.presets.length, 1); assert.equal(stored.presets[0].extensionField, 'record-B');
});
