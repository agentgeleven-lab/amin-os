import test from 'node:test';
import assert from 'node:assert/strict';
import { createInformation, PROMPT_KEY } from '../apps/information/service.js';
import { KEY, LIBRARY_KEY, empty, apply } from '../apps/information/model.js';
import { createOperationService, metadataWriteStatus } from '../apps/shared/operations.js';

const record = () => ({ id: 'doctor', name: '医生', kind: 'person', mode: 'retcon', fields: [{ id: 'job', category: '身份', label: '职业', value: '医生', status: 'known' }] });
function fixture() {
    const handlers = new Map(), prompts = new Map();
    const ctx = {
        chat: [{ name: '调查员', is_user: true, mes: '询问医生' }], chatMetadata: {}, getCurrentChatId: () => 'chat', saveMetadata: async () => {},
        setExtensionPrompt: (key, value) => prompts.set(key, value),
        eventTypes: { GENERATION_AFTER_COMMANDS: 'start', CHAT_CHANGED: 'chat', GENERATION_ENDED: 'end' },
        eventSource: { on(key, fn) { if (!handlers.has(key)) handlers.set(key, new Set()); handlers.get(key).add(fn); }, removeListener(key, fn) { handlers.get(key)?.delete(fn); } },
    };
    return { ctx, prompts, emit: key => { for (const fn of handlers.get(key) ?? []) fn(); } };
}

test('external information restore clears prompt and invalidates original editor basis', async () => {
    const { ctx, prompts, emit } = fixture(), service = createInformation(() => ctx), operation = createOperationService(() => ctx);
    try {
        await service.save(service.capture(), store => apply(store, ctx.chat, record())); emit('start');
        assert.match(prompts.get(PROMPT_KEY), /医生/);
        const old = service.capture(); let notices = 0; service.subscribe(() => notices++);
        operation.stage({ label: '恢复资料', patches: [{ path: [KEY], value: empty() }] }); await operation.confirm();
        assert.equal(prompts.get(PROMPT_KEY), ''); assert.ok(notices > 0); assert.throws(() => service.check(old), /变化/);
    } finally { service.dispose(); operation.dispose(); }
});
test('external library-only restore invalidates drafts, while own archive token can continue apply', async () => {
    const { ctx } = fixture(), service = createInformation(() => ctx), operation = createOperationService(() => ctx);
    try {
        const own = service.capture(), other = service.capture(); await service.saveRecord(own, record());
        assert.equal(service.check(own), ctx); assert.throws(() => service.check(other), /变化/);
        await service.save(own, store => apply(store, ctx.chat, record()));
        const draft = service.capture(); operation.stage({ label: '恢复收纳资料', patches: [{ path: [LIBRARY_KEY], value: [] }] }); await operation.confirm();
        assert.throws(() => service.check(draft), /变化/);
    } finally { service.dispose(); operation.dispose(); }
});
test('legacy save lease blocks a restore until persistence completes and releases on failure', async () => {
    const { ctx } = fixture(), service = createInformation(() => ctx), operation = createOperationService(() => ctx);
    let rejectSave; ctx.saveMetadata = () => new Promise((_, reject) => { rejectSave = reject; });
    try {
        const saving = service.saveRecord(service.capture(), record());
        assert.equal(metadataWriteStatus(() => ctx).busy, true);
        assert.throws(() => operation.stage({ label: '恢复资料', patches: [{ path: [LIBRARY_KEY], value: [] }] }), error => error.code === 'BUSY');
        rejectSave(Error('磁盘失败')); await assert.rejects(saving, /磁盘失败/);
        assert.equal(Object.hasOwn(ctx.chatMetadata, LIBRARY_KEY), false); assert.equal(metadataWriteStatus(() => ctx).busy, false);
        ctx.saveMetadata = async () => {}; operation.stage({ label: '恢复资料', patches: [{ path: [LIBRARY_KEY], value: [] }] }); await operation.confirm();
    } finally { service.dispose(); operation.dispose(); }
});
test('shared restore save failure blocks legacy writes until the same committed data is saved', async () => {
    const { ctx } = fixture(), service = createInformation(() => ctx), operation = createOperationService(() => ctx);
    try {
        ctx.saveMetadata = async () => { throw Error('磁盘失败'); };
        operation.stage({ label: '恢复资料', patches: [{ path: [KEY], value: empty() }] }); await assert.rejects(operation.confirm(), /磁盘失败/);
        const before = JSON.stringify(ctx.chatMetadata);
        await assert.rejects(service.saveRecord(service.capture(), record()), error => error.code === 'DIRTY');
        assert.equal(JSON.stringify(ctx.chatMetadata), before);
        ctx.saveMetadata = async () => {}; await operation.retrySave(); await service.saveRecord(service.capture(), record());
        assert.equal(service.library().length, 1);
    } finally { service.dispose(); operation.dispose(); }
});
test('in-place edits invalidate token and failed legacy save never rolls back a later replacement', async () => {
    const { ctx } = fixture(), service = createInformation(() => ctx);
    try {
        await service.save(service.capture(), store => apply(store, ctx.chat, record()));
        const old = service.capture(); ctx.chatMetadata[KEY].enabled = false;
        assert.throws(() => service.check(old), /变化/);
        let rejectSave; ctx.saveMetadata = () => new Promise((_, reject) => { rejectSave = reject; });
        const saving = service.save(service.capture(), store => ({ ...store, enabled: true }));
        const replacement = { ...empty(), limit: 5555 }; ctx.chatMetadata[KEY] = replacement;
        rejectSave(Error('写入失败')); await assert.rejects(saving, /写入失败/); assert.equal(ctx.chatMetadata[KEY], replacement);
    } finally { service.dispose(); }
});
test('old metadata object state event does not clear prompt for a newly loaded same-name chat', async () => {
    const first = fixture(), next = fixture(); let current = first.ctx;
    const service = createInformation(() => current), operation = createOperationService(() => first.ctx);
    try {
        current = next.ctx; next.prompts.set(PROMPT_KEY, '新聊天自己的提醒');
        operation.stage({ label: '旧上下文恢复', patches: [{ path: [KEY], value: empty() }] }); await operation.confirm();
        assert.equal(next.prompts.get(PROMPT_KEY), '新聊天自己的提醒');
    } finally { service.dispose(); operation.dispose(); }
});
test('archive completion after chat switch fails without undoing the successful original write', async () => {
    const first = fixture(), next = fixture(); let current = first.ctx, resolveSave;
    const service = createInformation(() => current);
    first.ctx.saveMetadata = () => new Promise(resolve => { resolveSave = resolve; });
    try {
        const saving = service.saveRecord(service.capture(), record()); current = next.ctx; resolveSave();
        await assert.rejects(saving, /保存期间聊天/);
        assert.equal(first.ctx.chatMetadata[LIBRARY_KEY].length, 1); assert.equal(next.ctx.chatMetadata[LIBRARY_KEY], undefined);
        assert.equal(metadataWriteStatus(() => first.ctx).busy, false);
    } finally { service.dispose(); }
});
