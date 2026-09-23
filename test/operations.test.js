import test from 'node:test';
import assert from 'node:assert/strict';
import { captureContext, assertContext, createOperationService, subscribeStateChanges, acquireMetadataWrite, metadataWriteStatus, publishExternalMetadataChange, chatPath, pathBelongs } from '../apps/shared/operations.js';

const A = 'amin_os_characters_v1', B = 'amin_os_inventory_v1';
const proposal = (value = 1) => ({ label: '更新数值', patches: [{ path: [A], value: { value } }], summary: { value } });
function setup() {
    let saves = 0;
    let ctx = { chat: [{ name: '角色', is_user: false, mes: '起点', swipe_id: 0 }], chatMetadata: {}, characterId: 1, getCurrentChatId: () => 'chat-a', saveMetadata: async () => { saves++; } };
    const getContext = () => ctx, service = createOperationService(getContext);
    return { getContext, service, get saves() { return saves; }, get ctx() { return ctx; }, set ctx(value) { ctx = value; } };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const code = expected => error => error.code === expected;

test('capture guards metadata identity, chat owner, message text, candidate and extra read dependencies', () => {
    const t = setup(); t.ctx.chatMetadata[A] = { value: 1 };
    const token = captureContext(t.getContext, [[A]]);
    assert.equal(assertContext(t.getContext, token), t.ctx);
    t.ctx.chatMetadata.unrelated = 123; assert.equal(assertContext(t.getContext, token), t.ctx);
    for (const [key, value] of [['mes', '更改'], ['swipe_id', 2], ['name', '别人'], ['is_user', true]]) {
        const old = t.ctx.chat[0][key]; t.ctx.chat[0][key] = value;
        assert.throws(() => assertContext(t.getContext, token), code('STALE_CONTEXT')); t.ctx.chat[0][key] = old;
    }
    t.ctx.chatMetadata[A].value = 2; assert.throws(() => assertContext(t.getContext, token), code('STALE_BASIS'));
    t.ctx.chatMetadata[A].value = 1; t.ctx.characterId = 2; assert.throws(() => assertContext(t.getContext, token), code('STALE_CONTEXT'));
    t.ctx.characterId = 1; t.ctx.chatMetadata = structuredClone(t.ctx.chatMetadata); assert.throws(() => assertContext(t.getContext, token), code('STALE_CONTEXT'));
    t.service.dispose();
});

test('token cannot be forged or edited to bypass stale data checks', () => {
    const t = setup(), token = t.service.capture([[A]]);
    assert.throws(() => { token.paths[0][0] = B; }, TypeError);
    assert.throws(() => assertContext(t.getContext, { ...token }), code('INVALID_TOKEN'));
    t.ctx.chatMetadata[A] = null; assert.throws(() => assertContext(t.getContext, token), code('STALE_BASIS'));
    t.service.dispose();
});

test('stage does not mutate metadata and preview/input edits do not alter the committed operation', async () => {
    const t = setup(), input = proposal(); const view = t.service.stage(input);
    assert.deepEqual(t.ctx.chatMetadata, {});
    input.patches[0].value.value = 50; view.patches[0].value.value = 100;
    const result = await t.service.confirm();
    assert.equal(t.ctx.chatMetadata[A].value, 1); assert.equal(result.saved, true); assert.equal(t.saves, 1);
    await assert.rejects(t.service.confirm(), code('NO_PENDING')); t.service.dispose();
});

test('supplied editor dependencies survive addition of write bases', async () => {
    const t = setup(); t.ctx.chatMetadata[B] = { currency: 10 };
    const token = t.service.capture([[B]]); t.service.stage(proposal(), token);
    t.ctx.chatMetadata[B].currency = 11;
    await assert.rejects(t.service.confirm(), code('STALE_BASIS')); assert.equal(t.ctx.chatMetadata[A], undefined); t.service.dispose();
});

test('simultaneous services share a metadata save lock and consume a confirmation once', async () => {
    const t = setup(), other = createOperationService(t.getContext), pending = deferred();
    t.ctx.saveMetadata = () => pending.promise;
    t.service.stage(proposal()); other.stage({ label: '背包', patches: [{ path: [B], value: {} }] });
    const saving = t.service.confirm();
    assert.equal(t.service.preview(), null); assert.equal(other.busy(), true); assert.equal(t.ctx.chatMetadata[A].value, 1);
    await assert.rejects(other.confirm(), code('BUSY')); await assert.rejects(t.service.confirm(), code('NO_PENDING'));
    pending.resolve(); await saving; assert.equal(other.busy(), false);
    await other.confirm(); assert.deepEqual(t.ctx.chatMetadata[B], {}); t.service.dispose(); other.dispose();
});

test('different chat metadata objects do not block each other', async () => {
    const a = setup(), b = setup(), pending = deferred(); a.ctx.saveMetadata = () => pending.promise;
    a.service.stage(proposal()); b.service.stage(proposal(2)); const saving = a.service.confirm();
    await b.service.confirm(); assert.equal(b.ctx.chatMetadata[A].value, 2); pending.resolve(); await saving; a.service.dispose(); b.service.dispose();
});

test('failure keeps one committed mutation and any service can retry persistence without repeating it', async () => {
    const t = setup(), other = createOperationService(t.getContext); let calls = 0;
    t.ctx.saveMetadata = async () => { if (++calls === 1) throw Error('断网'); };
    t.service.stage(proposal()); await assert.rejects(t.service.confirm(), error => error.code === 'SAVE_FAILED' && error.committed);
    assert.equal(t.service.dirty(), true); assert.equal(other.dirty(), true); assert.equal(t.service.preview(), null);
    assert.throws(() => other.stage(proposal(2)), code('DIRTY'));
    t.ctx.chatMetadata[A].value = 3; t.ctx.chatMetadata.unrelated = '之后的编辑';
    const retry = await other.retrySave();
    assert.equal(retry.retried, true); assert.equal(t.ctx.chatMetadata[A].value, 3); assert.equal(t.ctx.chatMetadata.unrelated, '之后的编辑');
    assert.equal(calls, 2); assert.equal(t.service.dirty(), false); assert.equal(await t.service.retrySave(), null); t.service.dispose(); other.dispose();
});

test('stale completion never announces current-chat success and remains dirty for retry in the source chat', async () => {
    const t = setup(), first = t.ctx, pending = deferred(); first.saveMetadata = () => pending.promise;
    t.service.stage(proposal()); const saving = t.service.confirm();
    t.ctx = { ...first, chatMetadata: {}, getCurrentChatId: () => 'chat-b' };
    pending.resolve(); await assert.rejects(saving, error => error.code === 'STALE_COMPLETION' && error.committed && error.uncertain);
    assert.deepEqual(t.ctx.chatMetadata, {}); assert.equal(t.service.dirty(), false); assert.equal(await t.service.retrySave(), null);
    t.ctx = first; assert.equal(t.service.dirty(), true); first.saveMetadata = async () => {}; await t.service.retrySave();
    assert.equal(t.service.dirty(), false); t.service.dispose();
});

test('changed candidate during save is stale, retry saves latest existing metadata without applying twice', async () => {
    const t = setup(), pending = deferred(); t.ctx.saveMetadata = () => pending.promise;
    t.service.stage(proposal()); const saving = t.service.confirm(); t.ctx.chat[0].swipe_id = 1;
    pending.resolve(); await assert.rejects(saving, code('STALE_COMPLETION'));
    t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); assert.equal(t.ctx.chatMetadata[A].value, 1); t.service.dispose();
});

test('external targeted edits during save are retained and stale completion is explicit', async () => {
    const t = setup(), pending = deferred(); t.ctx.saveMetadata = () => pending.promise;
    t.service.stage(proposal()); const saving = t.service.confirm(); t.ctx.chatMetadata[A].value = 55;
    pending.resolve(); await assert.rejects(saving, code('STALE_COMPLETION'));
    assert.equal(t.ctx.chatMetadata[A].value, 55); t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); assert.equal(t.ctx.chatMetadata[A].value, 55); t.service.dispose();
});

test('atomic nested writes preserve unrelated variables and reject forbidden metadata paths', async () => {
    const t = setup(); t.ctx.chatMetadata.variables = { '状态栏': 'old', '势力资料': 'old-org', userSecret: { untouched: true } };
    t.service.stage({ label: '角色与世界状态', patches: [{ path: [A], value: { version: 1 } }, { path: ['variables', '状态栏'], value: 'new' }] });
    await t.service.confirm(); assert.equal(t.ctx.chatMetadata.variables['状态栏'], 'new'); assert.equal(t.ctx.chatMetadata.variables['势力资料'], 'old-org'); assert.deepEqual(t.ctx.chatMetadata.variables.userSecret, { untouched: true });
    for (const path of [['variables'], ['variables', 'userSecret'], ['api_key'], ['amin_os_something_v1'], []]) {
        assert.throws(() => t.service.stage({ label: '错误', patches: [{ path, value: null }] }));
    }
    t.service.dispose();
});

test('malformed patch values and overlap are rejected before any mutation', () => {
    const t = setup(), circular = {}; circular.self = circular;
    const cases = [
        [{ path: [A], value: undefined }], [{ path: [A], value: NaN }], [{ path: [A], value: Infinity }],
        [{ path: [A], value: new Date() }], [{ path: [A], value: circular }], [{ path: [A], value: [, 1] }],
        [{ path: [A], value: { get bad() { throw Error('Getter executed'); } } }],
        [{ path: [A], value: JSON.parse('{"__proto__":{"x":1}}') }], [{ path: [A, '__proto__'], value: 1 }],
        [{ path: [A], value: {} }, { path: [A, 'value'], value: 2 }], [{ path: [A], value: {} }, { path: [A], remove: true }],
        [{ path: [A], value: 1, remove: true }], [{ path: [A], remove: false }], [{ path: [A], value: 1, extra: true }],
    ];
    for (const patches of cases) { assert.throws(() => t.service.stage({ label: '错误', patches })); assert.deepEqual(t.ctx.chatMetadata, {}); }
    t.service.dispose();
});

test('invalid second path or read-only root cannot partially apply the first patch', async () => {
    const t = setup(); t.ctx.chatMetadata[B] = 7;
    assert.throws(() => t.service.stage({ label: '复合', patches: [{ path: [A], value: {} }, { path: [B, 'child'], value: 2 }] }), code('INVALID_PARENT'));
    assert.equal(t.ctx.chatMetadata[A], undefined);
    t.ctx.chatMetadata[B] = {};
    t.service.stage({ label: '复合', patches: [{ path: [A], value: {} }, { path: [B], value: 2 }] });
    Object.defineProperty(t.ctx.chatMetadata, B, { writable: false });
    await assert.rejects(t.service.confirm(), code('READ_ONLY')); assert.equal(t.ctx.chatMetadata[A], undefined); assert.equal(t.saves, 0); t.service.dispose();
});

test('state events are synchronous after apply, isolated from listener failures, and carry persistence phase', async () => {
    const t = setup(), events = [], pending = deferred(); t.ctx.saveMetadata = () => pending.promise;
    const stopBad = subscribeStateChanges(() => { throw Error('view failed'); });
    const stop = subscribeStateChanges(detail => { events.push(detail); assert.equal(t.ctx.chatMetadata[A].value, 1); assert.equal(t.service.busy(), true); });
    t.service.stage(proposal()); const saving = t.service.confirm();
    assert.equal(events.length, 1); assert.equal(events[0].phase, 'applied'); assert.deepEqual(events[0].paths, [[A]]);
    pending.resolve(); await saving; assert.deepEqual(events.map(event => event.phase), ['applied', 'saved']); assert.equal(events[0].operationId, events[1].operationId);
    stop(); stopBad(); t.service.dispose();
});

test('synchronous applied listeners cannot race the global metadata lock', async () => {
    const t = setup(), other = createOperationService(t.getContext); let raced;
    t.service.stage(proposal()); other.stage({ label: '背包', patches: [{ path: [B], value: {} }] });
    const stop = subscribeStateChanges(detail => { if (detail.phase === 'applied') raced = other.confirm().catch(error => error.code); });
    await t.service.confirm(); assert.equal(await raced, 'BUSY'); assert.equal(t.ctx.chatMetadata[B], undefined); stop(); t.service.dispose(); other.dispose();
});

test('failed save emits applied once and retry emits saved without a second applied event', async () => {
    const t = setup(), events = []; const stop = subscribeStateChanges(detail => events.push(detail.phase));
    t.ctx.saveMetadata = async () => { throw Error('离线'); }; t.service.stage(proposal()); await assert.rejects(t.service.confirm());
    t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); assert.deepEqual(events, ['applied', 'saved']); stop(); t.service.dispose();
});

test('remove missing nested data never invents empty metadata records', async () => {
    const t = setup(); t.service.stage({ label: '清理', patches: [{ path: ['variables', '状态栏'], remove: true }] });
    await t.service.confirm(); assert.deepEqual(t.ctx.chatMetadata, {}); t.service.dispose();
});

test('intentional parent replacement remains valid when a captured child disappears', async () => {
    const t = setup(); t.ctx.chatMetadata[A] = { nested: { value: 1 } };
    const token = t.service.capture([[A, 'nested', 'value']]); t.service.stage({ label: '替换', patches: [{ path: [A], value: null }] }, token);
    await t.service.confirm(); assert.equal(t.ctx.chatMetadata[A], null); assert.equal(t.service.dirty(), false); t.service.dispose();
});

test('dispose does not cancel an applied operation or discard dirty data needed by another window', async () => {
    const t = setup(), pending = deferred(); t.ctx.saveMetadata = () => pending.promise;
    t.service.stage(proposal()); const saving = t.service.confirm(); t.service.dispose(); pending.reject(Error('offline')); await assert.rejects(saving, code('SAVE_FAILED'));
    const next = createOperationService(t.getContext); assert.equal(next.dirty(), true); t.ctx.saveMetadata = async () => {}; await next.retrySave(); assert.equal(next.dirty(), false); next.dispose();
});

test('no save interface fails before mutating and disposed service refuses writes', async () => {
    const t = setup(); delete t.ctx.saveMetadata; t.service.stage(proposal()); await assert.rejects(t.service.confirm(), code('NO_SAVE')); assert.deepEqual(t.ctx.chatMetadata, {});
    t.service.dispose(); assert.throws(() => t.service.stage(proposal()), code('DISPOSED')); await assert.rejects(t.service.retrySave(), code('DISPOSED'));
});

test('branch helpers preserve exact candidate prefixes and reject diverged branches', () => {
    const initial = [{ name: 'n', is_user: true, mes: 'm', swipe_id: 0 }], branch = [...initial, { mes: 'next' }];
    assert.equal(pathBelongs(chatPath(initial), chatPath(branch)), true); initial[0].swipe_id = 1;
    assert.equal(pathBelongs(chatPath(initial), chatPath([{ name: 'n', is_user: true, mes: 'm', swipe_id: 0 }])), false);
});

test('legacy writer lease and operation save exclude each other in both directions', async () => {
    const t = setup(); t.service.stage(proposal());
    const release = acquireMetadataWrite(t.getContext);
    assert.deepEqual(metadataWriteStatus(t.getContext), { busy: true, dirty: false });
    await assert.rejects(t.service.confirm(), code('BUSY'));
    assert.throws(() => acquireMetadataWrite(t.getContext), code('BUSY'));
    release(); release(); assert.deepEqual(metadataWriteStatus(t.getContext), { busy: false, dirty: false });
    const waiting = deferred(); t.ctx.saveMetadata = () => waiting.promise; const saving = t.service.confirm();
    assert.throws(() => acquireMetadataWrite(t.getContext), code('BUSY')); waiting.resolve(); await saving;
    const next = acquireMetadataWrite(t.getContext); release(); assert.equal(t.service.busy(), true); next(); assert.equal(t.service.busy(), false); t.service.dispose();
});

test('legacy lease checks supplied basis and cannot replace a dirty unsaved operation', async () => {
    const t = setup(), token = captureContext(t.getContext, [[A]]); t.ctx.chatMetadata[A] = 3;
    assert.throws(() => acquireMetadataWrite(t.getContext, token), code('STALE_BASIS'));
    t.service.stage(proposal()); t.ctx.saveMetadata = async () => { throw Error('offline'); }; await assert.rejects(t.service.confirm());
    assert.deepEqual(metadataWriteStatus(t.getContext), { busy: false, dirty: true });
    assert.throws(() => acquireMetadataWrite(t.getContext), code('DIRTY'));
    t.ctx.saveMetadata = async () => {}; await t.service.retrySave(); acquireMetadataWrite(t.getContext)(); t.service.dispose();
});

test('local state subscribers receive exact source metadata while detail is an isolated serializable copy', async () => {
    const t = setup(), details = [];
    const stop = subscribeStateChanges((detail, metadata) => { details.push(detail); assert.equal(metadata, t.ctx.chatMetadata); assert.equal(Object.hasOwn(detail, 'metadata'), false); });
    t.service.stage(proposal()); await t.service.confirm(); assert.equal(details.length, 2); stop(); t.service.dispose();
});

test('organization subpath writes preserve backups and library root is writable', async () => {
    const t = setup(); t.ctx.chatMetadata.amin_os_organizations_v1 = { locks: [], assessment: null, backups: [{ keep: 1 }] };
    t.service.stage({ label: '恢复组织评估与资料库', patches: [
        { path: ['amin_os_organizations_v1', 'locks'], value: ['organizations.group.name'] },
        { path: ['amin_os_organizations_v1', 'assessment'], value: { summary: '已核对' } },
        { path: ['amin_os_information_library_v1'], value: [{ id: 'document' }] },
    ] });
    await t.service.confirm(); assert.deepEqual(t.ctx.chatMetadata.amin_os_organizations_v1.backups, [{ keep: 1 }]);
    for (const path of [['amin_os_organizations_v1'], ['amin_os_organizations_v1', 'backups']]) assert.throws(() => t.service.stage({ label: '覆盖', patches: [{ path, value: {} }] }), code('FORBIDDEN_PATH'));
    t.service.dispose();
});

test('legacy change publication isolates subscribers, preserves lease and data, and never saves', () => {
    const t = setup(), seen = [], paths = [['amin_os_scene_v1']];
    const release = acquireMetadataWrite(t.getContext);
    t.ctx.chatMetadata.amin_os_scene_v1 = { version: 1, events: [] };
    const before = structuredClone(t.ctx.chatMetadata);
    const offBad = subscribeStateChanges(() => { throw Error('broken view'); });
    const off = subscribeStateChanges((detail, metadata) => { assert.equal(metadata, t.ctx.chatMetadata); seen.push(detail); detail.paths[0][0] = 'local listener edit'; });
    const notice = publishExternalMetadataChange(t.getContext, paths);
    assert.deepEqual(paths, [['amin_os_scene_v1']]); assert.deepEqual(notice.paths, paths);
    assert.equal(t.saves, 0); assert.equal(metadataWriteStatus(t.getContext).busy, true); assert.deepEqual(t.ctx.chatMetadata, before);
    publishExternalMetadataChange(t.getContext, paths, { phase: 'saved', operationId: notice.operationId });
    assert.equal(seen[0].operationId, seen[1].operationId); assert.deepEqual(seen.map(item => item.phase), ['applied', 'saved']);
    off(); offBad(); release(); t.service.dispose();
});

test('legacy change publication rejects forbidden paths and malformed phases without notifying', () => {
    const t = setup(); let emitted = 0; const off = subscribeStateChanges(() => { emitted++; });
    for (const paths of [[], [['variables']], [['api_key']], [['amin_os_scene_v1', '__proto__']]]) assert.throws(() => publishExternalMetadataChange(t.getContext, paths));
    assert.throws(() => publishExternalMetadataChange(t.getContext, [[A]], { phase: 'unknown' }), code('INVALID_PHASE'));
    assert.throws(() => publishExternalMetadataChange(t.getContext, [[A]], { operationId: '' }), code('INVALID_OPERATION'));
    assert.equal(emitted, 0); assert.equal(t.saves, 0); off(); t.service.dispose();
});
