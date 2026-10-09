import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createCurrentStoryStorage, CURRENT_STORY_KEY, CURRENT_STORY_FORMAT, currentStoryKey,
    validateCurrentStoryRecord } from '../apps/state2/current-story-storage.js';
import { chatIdentity } from '../apps/shared/operations.js';

const clone = value => structuredClone(value);
function fixture() {
    const records = new Map(), writes = [];
    let ctx = { chatId: 'current-a', getCurrentChatId() { return this.chatId; }, characterId: 0,
        characters: [{ avatar: 'npc.png' }], extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chat: [{ name: 'NPC', mes: '当前回复', swipes: [null, '当前回复'], swipe_id: 1,
            amin_story_message_id: 'unchanged-message', extra: { amin_story_candidate_id: 'duplicate', amin_story_v2: { keep: true } },
            swipe_info: [{ extra: { amin_story_candidate_id: 'duplicate' } }, { extra: { amin_story_candidate_id: 'duplicate' } }] }],
        chatMetadata: { integrity: 'ready', variables: { 状态栏: JSON.stringify({ 时间: 1 }), unrelated: 'keep-variable' },
            LWB_RULES_V2: { '状态栏.时间': { type: 'number' }, unrelated: { keep: true } },
            amin_os_story_storage_v2: { untouched: 'broken-legacy-index' },
            extensions: { LittleWhiteBox: { stateLogV2: { floors: { 5: { keep: 'native-log' } } }, stateCkptV2: { keep: 'native-checkpoints' } } } } };
    let failWrite = false, restoreCalls = 0;
    const files = { available: () => true,
        async get(key) { return clone(records.get(key) ?? null); },
        async put(key, record, { expected } = {}) {
            assert.ok(isDeepStrictEqual(records.get(key) ?? null, expected), 'store must receive the exact expected record');
            if (failWrite) throw Error('mutable file save failed');
            records.set(key, clone(record)); writes.push({ key, expected: clone(expected) });
        } };
    const service = createCurrentStoryStorage(() => ctx, { files, restoreState: async (_floor, snapshot) => {
        restoreCalls++;
        ctx.chatMetadata.variables = { unrelated: ctx.chatMetadata.variables.unrelated, ...clone(snapshot.variables) };
        ctx.chatMetadata.LWB_RULES_V2 = { unrelated: ctx.chatMetadata.LWB_RULES_V2.unrelated, ...clone(snapshot.rules) };
        return { restored: true, stale: false };
    } });
    return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, service, files, records, writes,
        get restoreCalls() { return restoreCalls; }, failWrite(value) { failWrite = value; } };
}
const setTime = (f, value) => { f.ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 时间: value }); };
const time = entry => entry.state.variables.状态栏.时间;
const stored = f => f.records.get(f.ctx.chatMetadata[CURRENT_STORY_KEY].key);

test('current-only enable accepts malformed Swipe data without reading legacy indices or changing chat', async () => {
    const f = fixture(), before = clone({ chat: f.ctx.chat, chatMetadata: f.ctx.chatMetadata });
    const result = await f.service.enable();
    assert.equal(result.enabled, true);
    assert.equal(result.check(), undefined);
    await result.verify();
    assert.deepEqual(f.ctx.chat, before.chat);
    assert.deepEqual(f.ctx.chatMetadata.variables, before.chatMetadata.variables);
    assert.deepEqual(f.ctx.chatMetadata.extensions, before.chatMetadata.extensions);
    assert.deepEqual(f.ctx.chatMetadata.amin_os_story_storage_v2, before.chatMetadata.amin_os_story_storage_v2);
    assert.equal(f.records.size, 1);
    assert.equal(f.ctx.chatMetadata[CURRENT_STORY_KEY].key, currentStoryKey(chatIdentity(f.ctx)));
    assert.equal(time(stored(f).current), 1);
    assert.equal(f.service.status().mode, 'current-only');
    assert.equal(f.service.status().backupCount, 0);
    assert.equal(f.restoreCalls, 0);
});

test('changed captures replace one mutable record and retain only the five previous states', async () => {
    const f = fixture(); await f.service.enable();
    const before = f.writes.length;
    assert.equal((await f.service.capture()).changed, false);
    assert.equal(f.writes.length, before);
    for (let value = 2; value <= 9; value++) { setTime(f, value); await f.service.capture(); }
    assert.equal(f.records.size, 1);
    assert.equal(time(stored(f).current), 9);
    assert.deepEqual(stored(f).backups.map(time), [8, 7, 6, 5, 4]);
    assert.equal(f.service.status().backupCount, 5);
    const after = f.writes.length;
    await f.service.capture();
    assert.equal(f.writes.length, after);
    assert.equal((await f.service.inspectStorage()).records, 1);
    assert.equal((await f.service.inspectIndex()).rows.length, 0);
    assert.equal((await f.service.inspectIndex()).currentOnly, true);
});

test('current-only snapshots preserve bracket and leading-dot owned rules through capture and import', async () => {
    const f = fixture();
    const rules = { "['状态栏'].时间": { type: 'number' }, '["状态栏"].地点': { type: 'string' },
        '..状态栏.天气': { nested: { enabled: true } } };
    f.ctx.chatMetadata.LWB_RULES_V2 = { ...clone(rules), "['unrelated'].keep": { keep: true } };
    await f.service.enable();
    assert.deepEqual((await f.service.readFloor(0)).rules, rules);
    const first = await f.service.exportStory();
    assert.deepEqual(first.record.current.state.rules, rules);
    f.ctx.chatMetadata.LWB_RULES_V2["['状态栏'].时间"].type = 'integer';
    const saved = await f.service.capture({ saveReceipt: true });
    assert.equal(saved.snapshot.rules["['状态栏'].时间"].type, 'integer');
    const check = f.service.consumeCaptureReceipt(saved.receipt, f.ctx);
    assert.equal(check(), undefined);
    f.ctx.chatMetadata.LWB_RULES_V2['..状态栏.天气'].nested.enabled = false;
    assert.throws(check, /变量已变化/);
    await f.service.importStory(first);
    assert.deepEqual((await f.service.readFloor(0)).rules, rules);
    assert.equal(f.ctx.chatMetadata.LWB_RULES_V2["['状态栏'].时间"].type, 'integer', 'import must not restore live rules');
    assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2["['unrelated'].keep"], { keep: true });
});

test('verified import can replace this chat\'s corrupt raw record and roll back its exact contents', async () => {
    const f = fixture(); await f.service.enable();
    const bundle = await f.service.exportStory(), key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
    const broken = { ...clone(stored(f)), revision: 'damaged', current: { broken: true }, hash: 'bad-checksum' };
    f.records.set(key, clone(broken));
    const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata });
    const imported = await f.service.importStory(bundle);
    validateCurrentStoryRecord(stored(f));
    assert.equal(imported.imported, true);
    await imported.verify();
    assert.equal(imported.check(), undefined);
    assert.deepEqual(f.writes.at(-1).expected, broken, 'compare-and-swap must use the raw damaged record');
    assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
    await imported.rollback();
    assert.deepEqual(f.records.get(key), broken, 'rollback preserves all damaged source fields verbatim');
    assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
});

test('import refuses unparseable or foreign records and failed writes preserve corrupt source', async () => {
    const f = fixture(); await f.service.enable();
    const bundle = await f.service.exportStory(), key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
    const original = clone(stored(f)), writes = f.writes.length;
    for (const value of ['unparsed-json', { ...original, owner: 'someone-else' }, { ...original, chat: 'other-chat' }]) {
        f.records.set(key, clone(value));
        await assert.rejects(f.service.importStory(bundle), error => error.code === 'STORY_CURRENT_IMPORT_UNSAFE_EXISTING');
        assert.deepEqual(f.records.get(key), value);
    }
    assert.equal(f.writes.length, writes);
    f.files.get = async () => { throw Object.assign(Error('malformed JSON'), { code: 'STORY_CURRENT_READ_FAILED' }); };
    await assert.rejects(f.service.importStory(bundle), /无法读取或解析，未覆盖/);
    f.files.get = async recordKey => clone(f.records.get(recordKey) ?? null);
    const broken = { ...original, hash: 'broken' }; f.records.set(key, broken); f.failWrite(true);
    await assert.rejects(f.service.importStory(bundle), /mutable file save failed/);
    assert.deepEqual(f.records.get(key), broken);
    assert.equal(f.writes.length, writes);
});

test('clear and backup restore preserve the latest unsaved owned variables and rules', async () => {
    for (const operation of ['clear', 'restore']) {
        const f = fixture(); await f.service.enable();
        setTime(f, 2); await f.service.capture();
        const previous = clone(stored(f));
        setTime(f, 99);
        f.ctx.chatMetadata.LWB_RULES_V2["['状态栏'].最新"] = { type: 'number', value: 99 };
        const liveVariables = clone(f.ctx.chatMetadata.variables), liveRules = clone(f.ctx.chatMetadata.LWB_RULES_V2);
        const tx = operation === 'clear' ? await f.service.clearCurrent() : await f.service.restoreCurrentBackup(0);
        assert.equal(time(stored(f).backups[0]), 99, 'actual live state must be the first recovery backup');
        assert.deepEqual(stored(f).backups[0].state.rules["['状态栏'].最新"], { type: 'number', value: 99 });
        assert.equal(time(stored(f).backups[1]), 2, 'persisted prior current remains a bounded recovery backup');
        assert.equal(stored(f).backups.length, 3);
        assert.deepEqual(f.ctx.chatMetadata.variables, liveVariables);
        assert.deepEqual(f.ctx.chatMetadata.LWB_RULES_V2, liveRules);
        assert.equal(Object.hasOwn(stored(f).backups[0].state.variables, 'unrelated'), false);
        await tx.verify(); await tx.rollback();
        assert.deepEqual(stored(f), previous);
        assert.deepEqual(f.ctx.chatMetadata.variables, liveVariables);
    }
});

test('reset refuses corrupt owned records with a validated-backup recovery instruction', async () => {
    const f = fixture(); await f.service.enable();
    const key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key, broken = { ...clone(stored(f)), hash: 'damaged' };
    f.records.set(key, broken);
    const count = f.writes.length;
    await assert.rejects(f.service.clearCurrent(), /先导入本聊天的有效当前状态备份/);
    assert.equal(f.writes.length, count);
    assert.deepEqual(f.records.get(key), broken);
});

test('owned edits during a delayed reset file write cancel before overlay and restore the prior record', async () => {
    const f = fixture(); await f.service.enable();
    const before = clone(stored(f)), originalPut = f.files.put;
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let first = true;
    f.files.put = async (...args) => {
        if (first) { first = false; entered(); await waiting; }
        return originalPut(...args);
    };
    const pending = f.service.clearCurrent();
    await started; setTime(f, 100); release();
    await assert.rejects(pending, error => error.code === 'STORY_CURRENT_STATE_CHANGED');
    assert.deepEqual(stored(f), before);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).时间, 100);
    assert.equal(f.restoreCalls, 0);
});

test('receipts are opaque one-use synchronous checks of context and captured owned state', async () => {
    const f = fixture(); await f.service.enable();
    const capture = await f.service.capture({ saveReceipt: true });
    const check = f.service.consumeCaptureReceipt(capture.receipt, f.ctx);
    assert.equal(typeof check, 'function');
    assert.equal(check(), undefined);
    assert.equal(f.service.consumeCaptureReceipt(capture.receipt, f.ctx), null);
    assert.equal(f.service.consumeCaptureReceipt(clone(capture.receipt), f.ctx), null);
    setTime(f, 20);
    assert.throws(check, /变量已变化/);
    const another = await f.service.capture({ saveReceipt: true });
    f.ctx.chat[0].swipes[0] = 'body changed';
    assert.throws(() => f.service.consumeCaptureReceipt(another.receipt, f.ctx), /聊天或候选已变化/);
});

test('fork and rename allocate separate deterministic records without writing to their parents', async () => {
    const f = fixture(); await f.service.enable();
    const parentKey = f.ctx.chatMetadata[CURRENT_STORY_KEY].key, parent = clone(stored(f));
    f.ctx = { ...f.ctx, chatId: 'branch-b', chat: clone(f.ctx.chat), chatMetadata: clone(f.ctx.chatMetadata) };
    setTime(f, 99);
    const fork = await f.service.ensureIndex();
    assert.equal(fork.changed, true);
    assert.notEqual(f.ctx.chatMetadata[CURRENT_STORY_KEY].key, parentKey);
    assert.deepEqual(f.records.get(parentKey), parent);
    assert.equal(time(stored(f).current), 1, 'fork starts from the parent persisted current state');
    await f.service.capture();
    assert.equal(time(stored(f).current), 99);
    assert.deepEqual(f.records.get(parentKey), parent);
    const branchKey = f.ctx.chatMetadata[CURRENT_STORY_KEY].key, branch = clone(stored(f));
    f.ctx.chatId = 'renamed-c';
    await f.service.ensureIndex();
    assert.equal(f.records.size, 3);
    assert.deepEqual(f.records.get(branchKey), branch);
    assert.deepEqual(f.records.get(parentKey), parent);
});

test('floor reads expose only current state and candidate generation never rewinds it', async () => {
    const f = fixture(); await f.service.enable();
    f.ctx.chat.push({ mes: null, swipes: [undefined], swipe_id: 20 });
    await assert.rejects(f.service.readFloor(0), /不提供旧楼层/);
    assert.equal(JSON.parse((await f.service.readFloor(1)).variables.状态栏).时间, 1);
    assert.equal((await f.service.restoreBeforeCandidate('swipe')).noRewind, true);
    assert.equal(f.restoreCalls, 0);
    setTime(f, 50);
    await f.service.restoreFloor(1);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).时间, 1);
    assert.equal(f.restoreCalls, 1);
    assert.equal(f.ctx.chatMetadata.variables.unrelated, 'keep-variable');
});

test('clear preserves the old state as a backup and transaction checks permit intentional live overlay', async () => {
    const f = fixture(); await f.service.enable();
    const before = clone(stored(f));
    const result = await f.service.clearCurrent();
    assert.deepEqual(result.snapshot, { variables: {}, rules: {} });
    assert.equal(time(stored(f).backups[0]), 1);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).时间, 1, 'file clear does not change live variables');
    delete f.ctx.chatMetadata.variables.状态栏;
    delete f.ctx.chatMetadata.LWB_RULES_V2['状态栏.时间'];
    assert.equal(result.check(), undefined);
    await result.verify();
    await result.rollback();
    assert.deepEqual(stored(f), before, 'a caller may roll back the file after separately rolling back its native overlay');
});

test('backup restore validates the displayed hash and preserves the pre-restore current state', async () => {
    const f = fixture(); await f.service.enable(); setTime(f, 2); await f.service.capture();
    const selection = (await f.service.inspectCurrentBackups()).backups[0];
    const before = clone(stored(f));
    await assert.rejects(f.service.restoreCurrentBackup(0, { expectedHash: 'sha256:' + '0'.repeat(64) }), /列表已变化/);
    assert.deepEqual(stored(f), before);
    const restored = await f.service.restoreCurrentBackup(0, { expectedHash: selection.hash });
    assert.equal(JSON.parse(restored.snapshot.variables.状态栏).时间, 1);
    assert.equal(time(stored(f).current), 1);
    assert.equal(time(stored(f).backups[0]), 2);
    assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).时间, 2);
    await restored.rollback();
    assert.deepEqual(stored(f), before);
});

test('a rotated backup list refuses a stale index/hash choice before writing', async () => {
    const f = fixture(); await f.service.enable(); setTime(f, 2); await f.service.capture();
    const selection = (await f.service.inspectCurrentBackups()).backups[0];
    setTime(f, 3); await f.service.capture();
    const before = clone(stored(f)), writes = f.writes.length;
    await assert.rejects(f.service.restoreCurrentBackup(selection.index, { expectedHash: selection.hash }), /列表已变化/);
    assert.deepEqual(stored(f), before);
    assert.equal(f.writes.length, writes);
});

test('switch with clear stores a recovery backup first and can roll back only its marker', async () => {
    const f = fixture(), chat = clone(f.ctx.chat), legacy = clone(f.ctx.chatMetadata.amin_os_story_storage_v2);
    const tx = await f.service.switchToCurrent({ clear: true });
    assert.deepEqual(stored(f).current.state.variables, {});
    assert.equal(time(stored(f).backups[0]), 1);
    assert.deepEqual(f.ctx.chat, chat);
    assert.deepEqual(f.ctx.chatMetadata.amin_os_story_storage_v2, legacy);
    await tx.rollback();
    assert.equal(f.ctx.chatMetadata[CURRENT_STORY_KEY], undefined);
    assert.equal(f.records.size, 1, 'the written switch recovery record remains recoverable');
});

test('stale transaction contexts reject checks and rollback without touching another chat or file', async () => {
    const f = fixture(); await f.service.enable();
    const tx = await f.service.clearCurrent(), after = clone([...f.records]);
    f.ctx = { ...f.ctx, chatId: 'other-chat', chatMetadata: clone(f.ctx.chatMetadata) };
    assert.throws(tx.check, /聊天或候选已变化/);
    await assert.rejects(tx.rollback(), /聊天或候选已变化/);
    assert.deepEqual([...f.records], after);
});

test('an external file change blocks transaction verification and compare-and-swap rollback', async () => {
    const f = fixture(); await f.service.enable();
    const previous = clone(stored(f)), tx = await f.service.clearCurrent();
    f.records.set(f.ctx.chatMetadata[CURRENT_STORY_KEY].key, previous);
    await assert.rejects(tx.verify(), /文件已变化/);
    await assert.rejects(tx.rollback(), /文件已变化/);
    assert.deepEqual(stored(f), previous);
});

test('file save failure leaves existing marker, live variables, and the previous record intact', async () => {
    const f = fixture(); f.failWrite(true);
    await assert.rejects(f.service.enable(), /mutable file save failed/);
    assert.equal(f.ctx.chatMetadata[CURRENT_STORY_KEY], undefined);
    assert.equal(f.records.size, 0);
    f.failWrite(false); await f.service.enable();
    const metadata = clone(f.ctx.chatMetadata), previous = clone(stored(f));
    f.failWrite(true);
    await assert.rejects(f.service.clearCurrent(), /mutable file save failed/);
    assert.deepEqual(f.ctx.chatMetadata, metadata);
    assert.deepEqual(stored(f), previous);
});

test('state and overall record checksums both reject corrupt backups before any write', async () => {
    const f = fixture(); await f.service.enable(); setTime(f, 2); await f.service.capture();
    const key = f.ctx.chatMetadata[CURRENT_STORY_KEY].key;
    const corrupted = clone(stored(f)); corrupted.backups[0].state.variables.状态栏.时间 = 30;
    const count = f.writes.length; f.records.set(key, corrupted);
    await assert.rejects(f.service.inspectCurrentBackups(), /校验不一致/);
    await assert.rejects(f.service.restoreCurrentBackup(0), /校验不一致/);
    assert.equal(f.writes.length, count);
    assert.throws(() => validateCurrentStoryRecord({ ...corrupted, hash: 'sha256:' + '0'.repeat(64) }), /校验不一致/);
});

test('current-mode backup import validates its format and chat and never restores live variables', async () => {
    const f = fixture(); await f.service.enable();
    const bundle = await f.service.exportStory();
    assert.equal(bundle.format, CURRENT_STORY_FORMAT);
    setTime(f, 9); await f.service.capture();
    const metadata = clone(f.ctx.chatMetadata), chat = clone(f.ctx.chat);
    await f.service.importStory(bundle);
    assert.deepEqual(f.ctx.chatMetadata, metadata);
    assert.deepEqual(f.ctx.chat, chat);
    assert.equal(time(stored(f).current), 1);
    assert.equal(f.restoreCalls, 0);
    await assert.rejects(f.service.importStory({ version: 2, marker: {}, graph: {} }), /不是仅当前状态/);
    f.ctx.chatId = 'other-chat';
    await assert.rejects(f.service.importStory(bundle), /属于另一条聊天/);
});
