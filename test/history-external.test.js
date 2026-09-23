import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HISTORY_KEY } from '../apps/status/history.js';
import { acquireMetadataWrite, createOperationService, metadataWriteStatus, subscribeStateChanges } from '../apps/shared/operations.js';

function fixture(options = {}) {
    let state = { hp: 8 }, saves = 0, chatSaves = 0, writes = 0, restores = 0, changed = 0;
    let ctx = { chatMetadata: {}, chat: [{ name: '角色', mes: '第一楼', swipe_id: 0, extra: { wsh_message_id: 'm1' } }], getCurrentChatId: () => 'a', saveMetadata: async () => { saves++; }, saveChat: async () => { chatSaves++; } };
    const context = () => ctx;
    const history = createHistory({ context, read: () => state, write: value => { state = value; writes++; }, changed: () => { changed++; }, beforeRestore: () => { restores++; }, ...options });
    return { history, context, get ctx() { return ctx; }, set ctx(value) { ctx = value; }, get state() { return state; }, set state(value) { state = value; }, get saves() { return saves; }, get chatSaves() { return chatSaves; }, get writes() { return writes; }, get restores() { return restores; }, get changed() { return changed; } };
}

test('adoptExternal records current tail once and leaves earlier records and unrelated history fields intact', () => {
    const t = fixture(); t.history.sync(); const old = structuredClone(t.ctx.chatMetadata[HISTORY_KEY].records['m1:0']);
    t.ctx.chat.push({ name: '用户', is_user: true, mes: '下一楼', extra: { wsh_message_id: 'm2' } });
    t.ctx.chatMetadata[HISTORY_KEY].extension = { preserve: true }; t.state = { hp: 12 };
    const saves = t.saves, changed = t.changed;
    assert.equal(t.history.adoptExternal(), true);
    assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m1:0'], old);
    assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m2:0'].state, { hp: 12 });
    assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].extension, { preserve: true });
    assert.equal(t.saves, saves); assert.equal(t.writes, 0); assert.equal(t.restores, 0); assert.equal(t.changed, changed + 1);
    t.history.sync(); assert.equal(t.saves, saves); assert.equal(t.changed, changed + 1);
});

test('unobserved swipe followed by external state adoption does not restore the stale candidate record', () => {
    const t = fixture(); t.history.sync(); t.ctx.chat[0].swipe_id = 1; t.state = { hp: 3 };
    const saves = t.saves; t.history.adoptExternal(); t.history.sync();
    assert.equal(t.writes, 0); assert.equal(t.restores, 0); assert.equal(t.saves, saves);
    assert.deepEqual(t.state, { hp: 3 }); assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m1:1'].state, { hp: 3 });
    t.ctx.chat[0].swipe_id = 0; t.history.sync(); assert.deepEqual(t.state, { hp: 8 });
});

test('unobserved truncation followed by adoption establishes the explicit restored value at new tail', () => {
    const t = fixture(); t.history.sync(); t.ctx.chat.push({ mes: '第二楼', extra: { wsh_message_id: 'm2' } }); t.state = { hp: 4 }; t.history.sync();
    const second = structuredClone(t.ctx.chatMetadata[HISTORY_KEY].records['m2:0']);
    t.ctx.chat.pop(); t.state = { hp: 99 }; const saves = t.saves;
    t.history.adoptExternal(); t.history.sync();
    assert.deepEqual(t.state, { hp: 99 }); assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m1:0'].state, { hp: 99 });
    assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m2:0'], second); assert.equal(t.saves, saves); assert.equal(t.restores, 0);
});

test('external adoption clears a previous missing-history block and supports an explicit null value', () => {
    const t = fixture(); t.history.sync(); t.ctx.chat[0].swipe_id = 1; t.history.sync(); assert.equal(t.state, null);
    const saves = t.saves, writes = t.writes; t.history.adoptExternal(); t.history.sync();
    assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m1:1'].state, null);
    assert.equal(t.saves, saves); assert.equal(t.writes, writes);
    t.state = { hp: 6 }; t.history.adoptExternal(); assert.deepEqual(t.history.list()[0].state, { hp: 6 }); assert.equal(t.saves, saves);
});

test('new chat and empty chat synchronize observers without replay or metadata save', () => {
    const t = fixture(); t.history.sync(); const old = t.ctx.chatMetadata;
    t.ctx = { ...t.ctx, chatMetadata: {}, chat: [], getCurrentChatId: () => 'b' }; t.state = { hp: 2 };
    const saves = t.saves; assert.equal(t.history.adoptExternal(), true); t.history.sync();
    assert.deepEqual(t.history.list(), []); assert.equal(t.writes, 0); assert.equal(t.saves, saves); assert.deepEqual(old[HISTORY_KEY].records['m1:0'].state, { hp: 8 });
});

test('new message IDs are saved to chat after observer adoption and reentrant sync cannot restore stale state', () => {
    const t = fixture(); t.history.sync(); t.ctx.chat[0].swipe_id = 1; delete t.ctx.chat[0].extra.wsh_message_id;
    let savesChat = 0; t.ctx.saveChat = () => { savesChat++; t.history.sync(); return Promise.resolve(); }; t.state = { hp: 22 };
    const saves = t.saves; t.history.adoptExternal();
    assert.equal(savesChat, 1); assert.equal(t.writes, 0); assert.equal(t.saves, saves); assert.equal(typeof t.ctx.chat[0].extra.wsh_message_id, 'string');
    assert.deepEqual(t.history.list()[0].state, { hp: 22 });
});

test('external state operation and adopted history are captured by the same single metadata save', async () => {
    const ctx = { chatMetadata: { variables: { '状态栏': '{"hp":8}' } }, chat: [{ mes: 'floor', extra: { wsh_message_id: 'floor' } }], getCurrentChatId: () => 'a', saveChat: async () => {} };
    let saves = 0, saved;
    ctx.saveMetadata = async () => { saves++; saved = structuredClone(ctx.chatMetadata); };
    const history = createHistory({ context: () => ctx, read: () => JSON.parse(ctx.chatMetadata.variables['状态栏']), write: () => { throw Error('must not restore'); } });
    const off = subscribeStateChanges(detail => { if (detail.phase === 'applied') history.adoptExternal(); });
    const operations = createOperationService(() => ctx);
    operations.stage({ label: '读档', patches: [{ path: ['variables', '状态栏'], value: '{"hp":17}' }] }); await operations.confirm();
    assert.equal(saves, 1); assert.deepEqual(saved[HISTORY_KEY].records['floor:0'].state, { hp: 17 });
    history.sync(); assert.equal(saves, 1); off(); operations.dispose();
});

test('malformed existing history is not reset and failed reads do not overwrite history', () => {
    const t = fixture(); t.ctx.chatMetadata[HISTORY_KEY] = { records: [], protected: 'keep' };
    assert.throws(() => t.history.adoptExternal(), /格式无效/); assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY], { records: [], protected: 'keep' });
    const bad = fixture({ read: () => { throw Error('bad value'); } }); bad.ctx.chatMetadata[HISTORY_KEY] = { records: { old: { state: 1 } } };
    assert.throws(() => bad.history.adoptExternal(), /bad value/); assert.deepEqual(bad.ctx.chatMetadata[HISTORY_KEY].records, { old: { state: 1 } }); assert.equal(bad.saves, 0);
    for (const value of [null, false, 0, '']) {
        const malformed = fixture(); malformed.ctx.chatMetadata[HISTORY_KEY] = value;
        assert.throws(() => malformed.history.adoptExternal(), /格式无效/); assert.equal(malformed.ctx.chatMetadata[HISTORY_KEY], value);
    }
});

test('configured organization history supports group chats without changing default group restriction', () => {
    const t = fixture({ allowGroups: true, historyKey: 'org_history', messageKey: 'org_id' }); t.ctx.groupId = 1;
    assert.equal(t.history.adoptExternal(), true); assert.ok(t.ctx.chat[0].extra.org_id); assert.ok(t.ctx.chatMetadata.org_history.records[t.ctx.chat[0].extra.org_id + ':0']); assert.equal(t.saves, 0);
    const blocked = fixture(); blocked.ctx.groupId = 1; assert.equal(blocked.history.adoptExternal(), false); assert.deepEqual(blocked.ctx.chatMetadata, {});
});

test('a pending history autosave holds the shared lease and blocks a later cross-app commit', async () => {
    const t = fixture(); let complete;
    t.ctx.saveMetadata = () => new Promise(resolve => { complete = resolve; });
    const operations = createOperationService(t.context);
    operations.stage({ label: '角色', patches: [{ path: ['amin_os_characters_v1'], value: { version: 1 } }] });
    t.history.sync(); assert.equal(metadataWriteStatus(t.context).busy, true);
    await assert.rejects(operations.confirm(), error => error.code === 'BUSY');
    complete(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(metadataWriteStatus(t.context).busy, false);
    t.ctx.saveMetadata = async () => {}; await operations.confirm(); t.history.dispose(); operations.dispose();
});

test('history changes during another writer save queue behind its lease and persist the newest record', async () => {
    const t = fixture(); const snapshots = [];
    t.ctx.saveMetadata = async () => { snapshots.push(structuredClone(t.ctx.chatMetadata)); };
    const release = acquireMetadataWrite(t.context); t.history.sync(); t.state = { hp: 21 }; t.history.sync();
    assert.equal(snapshots.length, 0); release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshots.length, 1); assert.deepEqual(snapshots[0][HISTORY_KEY].records['m1:0'].state, { hp: 21 }); t.history.dispose();
});

test('native writer can include synchronous history changes in its own save without a second autosave', async () => {
    const t = fixture(), release = acquireMetadataWrite(t.context);
    t.history.sync({ persist: false }); assert.equal(t.saves, 0);
    await t.ctx.saveMetadata(); release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.saves, 1); assert.deepEqual(t.ctx.chatMetadata[HISTORY_KEY].records['m1:0'].state, { hp: 8 }); t.history.dispose();
});
