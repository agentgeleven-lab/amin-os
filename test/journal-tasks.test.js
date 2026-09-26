import test from 'node:test';
import assert from 'node:assert/strict';
import { empty, change, currentEntries, snapshotJournal, validateJournalSnapshot, restoreJournal, exportRecords, parseImport, sourceFromRange, KEY } from '../apps/journal/model.js';
import { adapter } from '../apps/linkage/adapters/journal.js';

const chat = [{ mes: '调查古堡', name: '旅人', is_user: true }];
const task = { id: 'task-key', kind: 'task', title: '寻找钥匙', body: '调查地下室', goal: '找到钥匙', progress: 30, status: 'active', reward: '十枚金币', characterIds: ['hero'], locationIds: ['castle'], itemIds: ['key'] };
const clue = { id: 'clue-key', kind: 'clue', title: '钥匙位置', body: '据说钥匙挂在墙上', taskId: task.id, source: '向导传闻', confidence: 40 };

test('task and clue history survives native snapshot restore and import remaps task links', () => {
    let store = change(empty(), chat, 'create', task);
    store = change(store, chat, 'create', clue);
    const snapshot = snapshotJournal(store, chat);
    assert.deepEqual(validateJournalSnapshot(snapshot), snapshot);
    const restored = restoreJournal({ chat, chatMetadata: { [KEY]: empty() } }, snapshot);
    const entries = currentEntries(restored, chat);
    assert.equal(entries[0].goal, task.goal); assert.equal(entries[1].taskId, task.id);
    const imported = parseImport(exportRecords(store, chat));
    assert.notEqual(imported[0].id, task.id); assert.equal(imported[1].taskId, imported[0].id);
    assert.equal(imported[0].enabled, false);
});

test('invalid task and clue data are rejected without mutating existing archive', () => {
    for (const input of [{ ...task, progress: 101 }, { ...task, status: 'guessed' }, { ...task, characterIds: ['bad id'] }, { ...clue, confidence: -1 }, { ...clue, taskId: 'bad id' }]) {
        const store = empty(); assert.throws(() => change(store, chat, 'create', input)); assert.equal(store.events.length, 0);
    }
});

test('AI adapter only updates journal records; confidence and progress do not grant rewards', () => {
    const ctx = { chat, chatMetadata: {} };
    const created = adapter.apply(ctx, { action: 'set_task', target: task.id, reason: '发现任务', data: { title: task.title, body: task.body, progress: 100, reward: task.reward } }, { operationId: 'op-task', now: '2026-09-26' });
    assert.deepEqual(created.patches.map(item => item.path), [[KEY]]);
    ctx.chatMetadata[KEY] = created.patches[0].value;
    assert.equal(currentEntries(ctx.chatMetadata[KEY], chat)[0].status, 'open');
    const result = adapter.apply(ctx, { action: 'set_clue', target: clue.id, reason: '得到传闻', data: { title: clue.title, body: clue.body, taskId: task.id, confidence: 100 } }, { operationId: 'op-clue', now: '2026-09-26' });
    assert.equal(currentEntries(result.patches[0].value, chat)[1].status, 'unverified');
    assert.deepEqual(result.patches.map(item => item.path), [[KEY]]);
});

test('task progress follows branch history without inheriting future completion', () => {
    let store = change(empty(), chat, 'create', { ...task, sources: sourceFromRange(chat, 0, 0) });
    const later = [...chat, { mes: '找到钥匙', name: '向导' }];
    store = change(store, later, 'update', { ...task, status: 'completed', progress: 100 });
    assert.equal(currentEntries(store, chat)[0].status, 'active');
    assert.equal(currentEntries(store, later)[0].status, 'completed');
});
