import test from 'node:test';
import assert from 'node:assert/strict';
import * as Journal from '../apps/journal/model.js';
import * as Characters from '../apps/characters/model.js';
import { createJournal } from '../apps/journal/service.js';
import { adapter } from '../apps/linkage/adapters/journal.js';

const at = '2026-09-23T10:00:00.000Z';
const chat = () => [
    { name: '旅人', is_user: true, mes: '我问门口的人谁拿走了钥匙。' },
    { name: '守门人', is_user: false, mes: '我亲眼看见了，钥匙被馆长取走。' },
    { name: '旅人', is_user: true, mes: '我将这个消息转告给同伴。' },
    { name: '同伴', is_user: false, mes: '我只是听你转述，暂时不能确信。' },
];
const character = (id, name) => ({ id, name, kind: 'npc', stats: [], notes: '' });
function context() {
    const ctx = { chat: chat(), chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'journal-test' };
    ctx.chatMetadata[Characters.KEY] = Characters.appendSnapshot(Characters.emptyStore(), [], { version: 1, characters: [character('gatekeeper', '守门人'), character('companion', '同伴')] }, { id: 'people' });
    return ctx;
}
const fact = ctx => ({ id: 'key-fact', kind: 'fact', title: '钥匙去向', body: '守门人称馆长取走了钥匙。', truth: 'uncertain', sources: Journal.sourceFromRange(ctx.chat, 0, 1) });
const knowledge = ctx => ({ id: 'key-memory', kind: 'knowledge', title: '钥匙去向', body: '', factId: 'key-fact', characterId: 'companion', state: 'rumor', belief: '可能是馆长拿走的。', confidence: 40,
    learnedFromId: 'gatekeeper', learnedAtText: '第二日傍晚', sources: Journal.sourceFromRange(ctx.chat, 2, 3) });
function seed(ctx) {
    let store = Journal.changeWithContext(Journal.empty(), ctx, 'create', fact(ctx), 'fact', at);
    store = Journal.changeWithContext(store, ctx, 'create', knowledge(ctx), 'memory', at);
    ctx.chatMetadata[Journal.KEY] = store; return store;
}
const options = id => ({ operationId: id, now: at });
const operation = (action, target, data = {}) => ({ module: 'journal', action, target, data, reason: '正文已发生此变化' });
const apply = (ctx, op, id) => { const result = adapter.apply(ctx, op, options(id)); ctx.chatMetadata[Journal.KEY] = result.patches[0].value; return result; };

test('facts, beliefs, rumors and forgetting are separate branch-owned records', () => {
    const ctx = context(), store = seed(ctx), frozen = structuredClone(store), later = [...ctx.chat, { name: '主持人', mes: '同伴已忘记这段消息。' }];
    const next = Journal.changeWithContext(store, { ...ctx, chat: later }, 'update', { ...knowledge(ctx), state: 'forgotten' }, 'forget', at);
    assert.deepEqual(store, frozen);
    assert.equal(Journal.currentEntries(next, ctx.chat).find(entry => entry.kind === 'knowledge').state, 'rumor');
    assert.equal(Journal.currentEntries(next, later).find(entry => entry.kind === 'knowledge').state, 'forgotten');
    assert.equal(Journal.currentEntries(next, later).find(entry => entry.kind === 'fact').truth, 'uncertain');
    let enabled = Journal.change(next, later, 'reference', { id: 'key-memory', enabled: true }, 'reference', at);
    const prompt = Journal.compile(enabled, later); assert.match(prompt, /已遗忘/); assert.match(prompt, /不能|不可作为/); assert.match(prompt, /第二日傍晚/);
    enabled = Journal.change(enabled, later, 'delete', { id: 'key-fact' }, 'delete-fact', at);
    ctx.chat = later; ctx.chatMetadata[Journal.KEY] = enabled;
    const [memory] = Journal.readCharacterMemories(ctx, 'companion'); assert.equal(memory.fact, null); assert.match(memory.missing.join(''), /事实已删除/);
    assert.equal(Journal.compile(enabled, later), '');
});

test('memory references survive renames and never silently bind a same-name replacement', () => {
    const ctx = context(); seed(ctx);
    ctx.chatMetadata[Characters.KEY] = Characters.appendSnapshot(ctx.chatMetadata[Characters.KEY], ctx.chat, { version: 1, characters: [character('companion', '新名字')] }, { id: 'rename' });
    let [memory] = Journal.readCharacterMemories(ctx, 'companion'); assert.equal(memory.characterName, '新名字'); assert.match(memory.missing.join(''), /消息来源人物/);
    ctx.chatMetadata[Characters.KEY] = Characters.appendSnapshot(ctx.chatMetadata[Characters.KEY], ctx.chat, { version: 1, characters: [character('replacement', '新名字')] }, { id: 'replace' });
    [memory] = Journal.readCharacterMemories(ctx, 'companion'); assert.match(memory.characterName, /人物已缺失/); assert.equal(memory.characterId, 'companion');
    assert.equal(Journal.readCharacterMemories(ctx, 'replacement').length, 0);
    assert.throws(() => Journal.changeWithContext(Journal.readStore(ctx), ctx, 'create', { ...knowledge(ctx), id: 'invalid', characterId: 'missing' }, 'bad'), /现有人物/);
});

test('memory creation validates actual fact/person IDs and one memory per person and fact', () => {
    const ctx = context(), store = seed(ctx);
    assert.throws(() => Journal.changeWithContext(store, ctx, 'create', { ...knowledge(ctx), id: 'duplicate' }, 'duplicate'), /已经有该事实/);
    assert.throws(() => Journal.changeWithContext(store, ctx, 'create', { ...knowledge(ctx), id: 'missing-fact', factId: 'unknown' }, 'missing-fact'), /已有的事实/);
    assert.throws(() => Journal.changeWithContext(store, ctx, 'create', { ...knowledge(ctx), id: 'missing-source', learnedFromId: 'unknown' }, 'missing-source'), /来源人物不存在/);
    assert.throws(() => Journal.validateRecord({ ...knowledge(ctx), confidence: 101 }, ctx.chat), /0–100/);
    assert.throws(() => Journal.validateRecord({ ...fact(ctx), truth: 'certain-ish' }, ctx.chat), /确认程度/);
});

test('journal linkage uses validated pure patches and cannot enable references or edit settings', () => {
    const ctx = context(), baseline = structuredClone(ctx.chatMetadata);
    const result = adapter.apply(ctx, operation('set_fact', 'key-fact', { title: '钥匙去向', body: '钥匙被取走。', truth: 'confirmed', sourceStart: 0, sourceEnd: 1 }), options('fact-op'));
    assert.deepEqual(ctx.chatMetadata, baseline); assert.deepEqual(result.patches[0].path, [Journal.KEY]); ctx.chatMetadata[Journal.KEY] = result.patches[0].value;
    apply(ctx, operation('set_knowledge', 'memory-a', { factId: 'key-fact', characterId: 'companion', state: 'rumor', confidence: 25, learnedFromId: 'gatekeeper' }), 'memory-op');
    const state = adapter.read(ctx); assert.equal(state.entries.length, 2); assert.equal(state.memories[0].confidence, 25); assert.equal(state.entries[0].enabled, false);
    for (const data of [{ enabled: true }, { autoChronicle: { enabled: true } }, { origin: {} }]) assert.throws(() => adapter.apply(ctx, operation('set_fact', 'key-fact', data), options('blocked')), /未知字段/);
    assert.throws(() => adapter.apply(ctx, operation('set_knowledge', 'memory-a', { factId: 'other' }), options('missing')), /事实不存在/);
    apply(ctx, operation('forget', 'memory-a'), 'forgot'); assert.equal(adapter.read(ctx).memories[0].state, 'forgotten');
    apply(ctx, operation('delete', 'key-fact'), 'deleted'); const length = ctx.chatMetadata[Journal.KEY].events.length;
    apply(ctx, operation('delete', 'key-fact'), 'deleted'); assert.equal(ctx.chatMetadata[Journal.KEY].events.length, length);
    assert.match(adapter.read(ctx).memories[0].missing.join(''), /事实已删除/);
});

test('prequel references keep original evidence, require explicit review and never invent current sources', () => {
    const ctx = context(), old = Journal.change(Journal.empty(), ctx.chat, 'create', { ...fact(ctx), enabled: true }, 'old');
    const [prior] = Journal.parsePriorImport(Journal.exportRecords(old, ctx.chat), { work: '第一卷', sourceNote: '上一段聊天的已确认导出' });
    assert.equal(prior.enabled, false); assert.equal(prior.sources, null); assert.equal(prior.origin.sources.messages[0].text, ctx.chat[0].mes);
    let store = Journal.change(Journal.empty(), [{ mes: '第二卷开篇' }], 'create', prior, 'import');
    assert.equal(Journal.compile(store, [{ mes: '第二卷开篇' }]), '');
    store = Journal.change(store, [{ mes: '第二卷开篇' }], 'reference', { id: prior.id, enabled: true }, 'enable');
    const prompt = Journal.compile(store, [{ mes: '第二卷开篇' }]); assert.match(prompt, /第一卷/); assert.match(prompt, /前作参考/); assert.doesNotMatch(prompt, /来源楼层/);
    const [ordinary] = Journal.parseImport(Journal.exportRecords(store, [{ mes: '第二卷开篇' }])); assert.equal(ordinary.explicitReference, false);
    assert.throws(() => Journal.validateRecord({ ...ordinary, enabled: true }, []), /明确确认/);
});

test('journal export remaps fact IDs and preserves character IDs without guessing identity', () => {
    const ctx = context(), store = seed(ctx), imported = Journal.parseImport(Journal.exportRecords(store, ctx.chat));
    const importedFact = imported.find(record => record.kind === 'fact'), importedMemory = imported.find(record => record.kind === 'knowledge');
    assert.notEqual(importedFact.id, 'key-fact'); assert.equal(importedMemory.factId, importedFact.id); assert.equal(importedMemory.characterId, 'companion');
    assert.equal(importedMemory.enabled, false); assert.equal(importedMemory.sources, null);
});

test('automatic chronicle ranges are opt-in, branch-owned and idempotent after confirmation', () => {
    const ctx = context(); assert.deepEqual(Journal.dueRanges(Journal.empty(), ctx.chat), []);
    let store = Journal.configureAuto(Journal.empty(), { enabled: true, every: 2, start: 0, instruction: '' });
    assert.deepEqual(Journal.dueRanges(store, ctx.chat), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
    const draft = { id: 'range-one', title: '钥匙消息', body: '同伴听到了有关钥匙的传闻。', sources: Journal.sourceFromRange(ctx.chat, 0, 1) };
    store = Journal.putAutoDraft(store, ctx.chat, draft, 'draft', at);
    assert.equal(Journal.currentEntries(store, ctx.chat).length, 0); assert.equal(Journal.compile(store, ctx.chat), '');
    assert.deepEqual(Journal.putAutoDraft(store, ctx.chat, draft, 'draft', at), store);
    assert.throws(() => Journal.putAutoDraft(store, ctx.chat, { ...draft, id: 'duplicate-range' }, 'duplicate', at), /不能重复/);
    store = Journal.putAutoDraft(store, ctx.chat, { ...draft, body: '用户请求重生成的草稿' }, 'regenerated', at);
    assert.equal(Journal.currentDrafts(store, ctx.chat).length, 1);
    store = Journal.resolveAutoDraft(store, ctx.chat, draft.id, 'accept', { body: '审核修改后的摘要' }, 'accept', at);
    store = Journal.resolveAutoDraft(store, ctx.chat, draft.id, 'accept', {}, 'accept', at);
    assert.equal(Journal.currentEntries(store, ctx.chat).length, 1); assert.equal(Journal.currentEntries(store, ctx.chat)[0].body, '审核修改后的摘要');
    assert.equal(Journal.currentEntries(store, ctx.chat)[0].enabled, false);
    assert.throws(() => Journal.resolveAutoDraft(store, ctx.chat, draft.id, 'accept', {}, 'accept-again', at), /已处理/);
    assert.deepEqual(Journal.dueRanges(store, ctx.chat), [{ start: 2, end: 3 }]);
    assert.equal(Journal.currentDrafts(store, ctx.chat.slice(0, 2)).length, 0);
    const branch = structuredClone(ctx.chat); branch[3].mes = '另一个回复候选'; assert.equal(Journal.currentDrafts(store, branch).length, 0);
});

test('snapshot round trips include new records and drafts, while old snapshots disable automation', () => {
    const ctx = context(); let store = seed(ctx);
    store = Journal.configureAuto(store, { enabled: true, every: 2, start: 0, instruction: '保留不确定性' });
    store = Journal.putAutoDraft(store, ctx.chat, { id: 'draft-a', title: '片段', body: '待审核内容', sources: Journal.sourceFromRange(ctx.chat, 0, 1) }, 'draft-op', at);
    ctx.chatMetadata[Journal.KEY] = store; const snapshot = Journal.snapshotJournal(store, ctx.chat), warnings = [];
    assert.equal(snapshot.entries.length, 2); assert.equal(snapshot.drafts[0].status, 'ready');
    let index = 0; const restored = Journal.restoreJournal(ctx, snapshot, { at, makeId: () => `restore-${index++}`, warnings });
    assert.equal(Journal.currentEntries(restored, ctx.chat).length, 2); assert.equal(Journal.currentDrafts(restored, ctx.chat).length, 1); assert.deepEqual(warnings, []);
    const old = Journal.restoreJournal({ ...ctx, chatMetadata: { ...ctx.chatMetadata, [Journal.KEY]: restored } }, { version: 1, limit: 40000, entries: snapshot.entries }, { at, makeId: () => `old-${index++}` });
    assert.equal(Journal.autoSettings(old).enabled, false); assert.equal(Journal.currentDrafts(old, ctx.chat).length, 0);
    const other = { ...ctx, chat: [{ mes: '新聊天' }] }, foreign = Journal.restoreJournal(other, snapshot, { at, makeId: () => `foreign-${index++}`, warnings });
    assert.equal(Journal.currentDrafts(foreign, other.chat)[0].status, 'dismissed'); assert.equal(Journal.currentEntries(foreign, other.chat)[0].sources, null);
    assert.match(warnings.join(''), /来源不匹配/);
    assert.throws(() => Journal.validateJournalSnapshot({ ...snapshot, drafts: [{ ...snapshot.drafts[0], sources: { start: 0, end: 1, messages: [] } }] }), /来源范围/);
});

function host({ enabled = false, generate = async () => '整理后的摘要' } = {}) {
    const ctx = context(); ctx.chat = ctx.chat.slice(0, 2);
    ctx.chatMetadata[Journal.KEY] = Journal.configureAuto(Journal.empty(), { enabled, every: 2, start: 0, instruction: '' });
    const handlers = new Map(), calls = []; let saves = 0;
    ctx.saveMetadata = async () => { saves++; }; ctx.setExtensionPrompt = () => {};
    const names = ['GENERATION_AFTER_COMMANDS','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_UPDATED'];
    ctx.eventTypes = Object.fromEntries(names.map(name => [name, name])); ctx.eventSource = { on: (name, fn) => handlers.set(name, fn), removeListener: name => handlers.delete(name) };
    const ai = { capture: app => ({ app }), generate: (...args) => { calls.push(args); return generate(...args); } };
    const api = createJournal(() => ctx, { ai: () => ai });
    return { ctx, api, calls, saves: () => saves, emit: (name, ...args) => handlers.get(name)?.(...args) };
}
test('normal generation creates one reviewable automatic draft; quiet/stopped/default-off flows create none', async () => {
    const disabled = host(); disabled.emit('GENERATION_AFTER_COMMANDS', 'normal'); await disabled.emit('GENERATION_ENDED'); assert.equal(disabled.calls.length, 0); disabled.api.dispose();
    const h = host({ enabled: true });
    h.emit('GENERATION_AFTER_COMMANDS', 'quiet'); await h.emit('GENERATION_ENDED'); assert.equal(h.calls.length, 0);
    h.emit('GENERATION_AFTER_COMMANDS', 'normal'); h.emit('GENERATION_STOPPED'); await h.emit('GENERATION_ENDED'); assert.equal(h.calls.length, 0);
    h.emit('GENERATION_AFTER_COMMANDS', 'normal'); await h.emit('GENERATION_ENDED'); assert.equal(h.calls.length, 1); assert.equal(h.saves(), 1);
    assert.equal(Journal.currentEntries(h.api.read(), h.ctx.chat).length, 0); assert.equal(Journal.currentDrafts(h.api.read(), h.ctx.chat)[0].status, 'ready');
    assert.equal(h.calls[0][3].snapshot.app, 'journal'); assert.equal(h.api.autoBusy(), false);
    h.emit('GENERATION_AFTER_COMMANDS', 'regenerate'); await h.emit('GENERATION_ENDED'); assert.equal(h.calls.length, 1); assert.equal(h.saves(), 1); h.api.dispose();
});

test('automatic draft failures do not change metadata; retries store one draft and stale results are discarded', async () => {
    const h = host({ enabled: true }), baseline = structuredClone(h.ctx.chatMetadata);
    h.ctx.saveMetadata = async () => { throw Error('offline'); };
    await assert.rejects(h.api.generateAutoDraft(), /offline/); assert.deepEqual(h.ctx.chatMetadata, baseline); assert.equal(h.api.autoBusy(), false);
    h.ctx.saveMetadata = async () => {}; await h.api.generateAutoDraft(); assert.equal(Journal.currentDrafts(h.api.read(), h.ctx.chat).length, 1); h.api.dispose();
    let resolve; const stale = host({ enabled: true, generate: () => new Promise(done => { resolve = done; }) });
    const pending = stale.api.generateAutoDraft(); const rejection = assert.rejects(pending, /楼层|聊天|取消/);
    stale.ctx.chat[1].mes = '编辑后的原文'; stale.emit('MESSAGE_UPDATED'); resolve('旧草稿'); await rejection;
    assert.equal(Journal.currentDrafts(stale.api.read(), stale.ctx.chat).length, 0); assert.equal(stale.saves(), 0); stale.api.dispose();
});

test('unified chronicle updates only create a draft and never expose unconfirmed prose in read data', () => {
    const ctx = context(); apply(ctx, operation('draft_chronicle', 'model-draft', { title: '新草稿', body: '尚待核对', sourceStart: 0, sourceEnd: 1 }), 'draft-op');
    assert.equal(adapter.read(ctx).entries.length, 0); assert.equal(Journal.currentDrafts(Journal.readStore(ctx), ctx.chat).length, 1);
    assert.throws(() => adapter.apply(ctx, operation('draft_chronicle', 'model-draft-two', { title: '重复范围', body: '尚待核对', sourceStart: 0, sourceEnd: 1 }), options('second-op')), /不能重复/);
});

test('unified prompt respects individual references and does not disclose prequel evidence or resolved names', () => {
    const ctx = context(); let store = seed(ctx);
    const [prior] = Journal.parsePriorImport(Journal.exportRecords(store, ctx.chat), { work: '秘密前作', sourceNote: '仅在明确选用后提供' });
    store = Journal.change(store, ctx.chat, 'create', prior, 'prior-import'); ctx.chatMetadata[Journal.KEY] = store;
    const hidden = adapter.readForPrompt(ctx); assert.equal(hidden.entries.length, 0); assert.equal(hidden.unavailable.length, 3);
    const hiddenText = JSON.stringify(hidden); assert.doesNotMatch(hiddenText, /秘密前作|钥匙去向|馆长|守门人|同伴/);
    store = Journal.change(store, ctx.chat, 'reference', { id: 'key-memory', enabled: true }, 'memory-on');
    store = Journal.change(store, ctx.chat, 'reference', { id: prior.id, enabled: true }, 'prior-on'); ctx.chatMetadata[Journal.KEY] = store;
    const shown = adapter.readForPrompt(ctx), memory = shown.entries.find(entry => entry.kind === 'knowledge'), previous = shown.entries.find(entry => entry.kind === 'prior');
    assert.equal(memory.characterId, 'companion'); assert.equal(Object.hasOwn(memory, 'characterName'), false); assert.equal(Object.hasOwn(memory, 'learnedFromName'), false);
    assert.equal(previous.origin.work, '秘密前作'); assert.equal(Object.hasOwn(previous.origin, 'sources'), false);
    assert.doesNotMatch(Journal.compile(store, ctx.chat), /事实内容/);
    ctx.chat[0].mes = '发生来源变化'; assert.equal(adapter.readForPrompt(ctx).entries.length, 0);
});
