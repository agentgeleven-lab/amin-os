import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStorage, STORY_STORAGE_KEY } from '../apps/state2/story-storage.js';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { candidateId, STORY_CANDIDATE_ID } from '../apps/shared/story-chat-index.js';

const clone = value => structuredClone(value);
const sourceText = (metadata, chat) => [JSON.stringify({ chat_metadata: metadata }),
    ...chat.map(message => JSON.stringify(message))].join('\n');

async function fixture() {
    const nodes = new Map();
    const graph = createStoryStateGraph({
        async get(id) { return clone(nodes.get(id) ?? null); },
        async put(id, node) { nodes.set(id, clone(node)); },
    });
    let ctx = {
        chatId: 'identity-recovery', getCurrentChatId() { return this.chatId; },
        characterId: 0, characters: [{ avatar: 'npc.png' }],
        extensionSettings: { LittleWhiteBox: { variablesMode: '2.0' } },
        chat: [{ name: 'NPC', mes: '开场', is_user: false }],
        chatMetadata: { integrity: 'ready', variables: { 状态栏: JSON.stringify({ 日程: 1 }), unrelated: 'keep' },
            LWB_RULES_V2: {}, extensions: { LittleWhiteBox: {
                stateLogV2: { version: 1, floors: {} }, stateCkptV2: { version: 1, points: {} },
            } } },
    };
    let restores = 0;
    const service = createStoryStorage(() => ctx, { graph, restoreState: async () => {
        restores++;
        return { restored: true, stale: false };
    } });
    await service.enable();
    await service.ensureIndex();
    const message = { name: 'NPC', mes: '第一候选', swipes: ['第一候选', '第二候选'], swipe_id: 0,
        extra: { unrelated: 'top' }, swipe_info: [{ extra: { unrelated: 'first' } }, { extra: { unrelated: 'second' } }] };
    ctx.chat.push(message);
    ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 2 });
    const first = await service.capture();
    message.swipe_id = 1;
    message.mes = message.swipes[1];
    ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 3 });
    const second = await service.capture();
    assert.notEqual(first.stateId, second.stateId);
    const originalChat = clone(ctx.chat), originalMetadata = clone(ctx.chatMetadata);
    const source = sourceText(originalMetadata, originalChat);
    // Simulate an unrelated live value; identity recovery must never archive it.
    ctx.chatMetadata.variables.状态栏 = JSON.stringify({ 日程: 99 });
    function corrupt(kind = 'duplicate') {
        if (kind === 'missing') delete message.swipe_info[1].extra[STORY_CANDIDATE_ID];
        else message.swipe_info[1].extra[STORY_CANDIDATE_ID] = candidateId(message, 0);
        message.extra[STORY_CANDIDATE_ID] = candidateId(message, 0);
    }
    return { get ctx() { return ctx; }, set ctx(value) { ctx = value; }, nodes, graph, service,
        source, originalChat, originalMetadata, message, first, second, corrupt,
        get restores() { return restores; } };
}

for (const kind of ['duplicate', 'missing']) {
    test(`source-backed preview repairs ${kind} candidate identity while retaining both original states`, async () => {
        const f = await fixture();
        f.corrupt(kind);
        const beforeChat = clone(f.ctx.chat), beforeMetadata = clone(f.ctx.chatMetadata), beforeNodes = clone([...f.nodes]);
        const preview = await f.service.inspectIdentityRecovery(f.source);
        assert.ok(preview.plan);
        assert.ok(preview.rows.length + preview.mirrors.length > 0);
        assert.deepEqual(f.ctx.chat, beforeChat, 'preview must not assign identities');
        assert.deepEqual(f.ctx.chatMetadata, beforeMetadata);
        assert.deepEqual([...f.nodes], beforeNodes, 'preview must not write a replacement index');

        const result = await f.service.repairIdentities(preview.plan);
        assert.equal(result.changed, true);
        assert.equal(typeof result.rollback, 'function');
        assert.deepEqual(f.ctx.chat, f.originalChat, 'only corrupted identities should differ from the source');
        assert.deepEqual(f.ctx.chatMetadata, beforeMetadata, 'variables, native logs, marker and unrelated metadata stay intact');
        assert.deepEqual([...f.nodes], beforeNodes);
        assert.equal(f.restores, 0, 'identity repair must not restore variables');
        assert.equal((await f.service.readFloor(1)).stateId, f.second.stateId);
        f.message.swipe_id = 0;
        f.message.mes = f.message.swipes[0];
        f.message.extra[STORY_CANDIDATE_ID] = candidateId(f.message, 0);
        assert.equal((await f.service.readFloor(1)).stateId, f.first.stateId);
        assert.equal(JSON.parse(f.ctx.chatMetadata.variables.状态栏).日程, 99);
    });

    test(`identity repair rollback restores exact ${kind} metadata without touching body or state`, async () => {
        const f = await fixture();
        f.corrupt(kind);
        const beforeChat = clone(f.ctx.chat), beforeMetadata = clone(f.ctx.chatMetadata);
        const preview = await f.service.inspectIdentityRecovery(f.source);
        const result = await f.service.repairIdentities(preview.plan);
        result.rollback();
        assert.deepEqual(f.ctx.chat, beforeChat);
        assert.deepEqual(f.ctx.chatMetadata, beforeMetadata);
        assert.equal(f.restores, 0);
    });
}

const staleChanges = {
    message: f => { f.message.mes += ' edited'; },
    unselectedSwipe: f => { f.message.swipes[0] += ' edited'; },
    candidateIdentity: f => { f.message.swipe_info[0].extra[STORY_CANDIDATE_ID] = 'changed-after-preview'; },
    selection: f => { f.message.swipe_id = 0; f.message.mes = f.message.swipes[0]; },
    marker: f => { f.ctx.chatMetadata[STORY_STORAGE_KEY].indexId = f.ctx.chatMetadata[STORY_STORAGE_KEY].baseStateId; },
    chat: f => { f.ctx = { ...f.ctx, chatId: 'other-chat' }; },
};
for (const [kind, change] of Object.entries(staleChanges)) {
    test(`identity repair rejects a stale ${kind} preview before applying any fields`, async () => {
        const f = await fixture();
        f.corrupt();
        const preview = await f.service.inspectIdentityRecovery(f.source);
        change(f);
        const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata });
        await assert.rejects(f.service.repairIdentities(preview.plan));
        assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
    });
}

test('identity recovery rejects a source from another baseline or with mismatched candidate prose', async () => {
    for (const mismatch of ['baseline', 'body']) {
        const f = await fixture();
        f.corrupt();
        const metadata = clone(f.originalMetadata), chat = clone(f.originalChat);
        if (mismatch === 'baseline') metadata[STORY_STORAGE_KEY].baseStateId = 'sha256:' + 'f'.repeat(64);
        else chat[1].swipes[0] = 'source changed';
        const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata });
        await assert.rejects(f.service.inspectIdentityRecovery(sourceText(metadata, chat)));
        assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
    }
});

test('identity repair rejects fabricated and serialized preview tokens', async () => {
    const f = await fixture();
    f.corrupt();
    const preview = await f.service.inspectIdentityRecovery(f.source);
    const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata });
    for (const plan of [{}, clone(preview.plan), JSON.parse(JSON.stringify(preview.plan))]) {
        await assert.rejects(f.service.repairIdentities(plan));
        assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
    }
});

test('identity recovery refuses a source state whose external file is missing', async () => {
    const f = await fixture();
    f.corrupt();
    f.nodes.delete(f.second.stateId);
    const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata });
    await assert.rejects(f.service.inspectIdentityRecovery(f.source));
    assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata }, before);
});

function storageLocatedError(source, field, swipe, detail) {
    return error => {
        assert.equal(error.source, source);
        assert.equal(error.floor, 1);
        if (field !== undefined) assert.equal(error.field, field);
        assert.match(error.message, source === 'original' ? /原聊天文件/ : /当前聊天/);
        assert.match(error.message, /第\s*2\s*楼/);
        if (swipe !== undefined) {
            assert.equal(error.swipe, swipe);
            assert.match(error.message, new RegExp(`Swipe\\s*${swipe + 1}(?:\\D|$)`));
        }
        if (detail) assert.match(error.message, detail);
        return true;
    };
}

const malformedBodies = {
    null: message => { message.swipes[0] = null; },
    sparse: message => { delete message.swipes[0]; },
    number: message => { message.swipes[0] = 17; },
    undefined: message => { message.swipes[0] = undefined; },
};
for (const source of ['original', 'current']) {
    for (const [kind, mutate] of Object.entries(malformedBodies)) {
        test(`storage keeps the precise ${source} location for ${kind} unselected Swipe without writing`, async () => {
            const f = await fixture(); f.corrupt();
            const sourceChat = clone(f.originalChat);
            mutate(source === 'original' ? sourceChat[1] : f.message);
            const text = source === 'original' ? sourceText(f.originalMetadata, sourceChat) : f.source;
            const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes], sourceChat });
            const detail = kind === 'number' ? /number|数字|数值/i
                : source === 'original' || kind === 'null' ? /null|空值/i
                : /缺失|空位|不存在|undefined/i;
            await assert.rejects(f.service.inspectIdentityRecovery(text), storageLocatedError(source, 'swipes', 0, detail));
            assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes], sourceChat }, before);
            assert.equal(f.restores, 0);
        });
    }

    test(`storage preserves selected mismatch code and the ${source} second-floor Swipe location`, async () => {
        const f = await fixture(); f.corrupt();
        const sourceChat = clone(f.originalChat);
        (source === 'original' ? sourceChat[1] : f.message).mes = 'mismatched selected body';
        const text = source === 'original' ? sourceText(f.originalMetadata, sourceChat) : f.source;
        const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] });
        await assert.rejects(f.service.inspectIdentityRecovery(text), error => {
            assert.equal(error.code, 'INCOMPLETE_CANDIDATE');
            return storageLocatedError(source, 'mes', 1, /不一致|不匹配|不同|尚未保存完整/)(error);
        });
        assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] }, before);
    });
}

test('storage retains a matching failure location after successful JSONL parsing instead of reporting a parse error', async () => {
    const f = await fixture(); f.corrupt();
    f.message.swipes[0] = 'body absent from supplied original';
    const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] });
    await assert.rejects(f.service.inspectIdentityRecovery(f.source), storageLocatedError('current', undefined, 0, /正文无法唯一匹配/));
    assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] }, before);
});

for (const line of [1, 2, 3]) {
    test(`storage reports invalid JSONL line ${line}, including the header in the count, without writing`, async () => {
        const f = await fixture(); f.corrupt();
        const lines = f.source.split('\n');
        lines[line - 1] = '{"unfinished":';
        const before = clone({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] });
        await assert.rejects(f.service.inspectIdentityRecovery(lines.join('\n')), error => {
            assert.equal(error.source, 'original');
            assert.equal(error.line, line);
            assert.equal(error.code, 'STORY_IDENTITY_SOURCE');
            assert.match(error.message, new RegExp(`第\\s*${line}\\s*行`));
            assert.match(error.message, /JSONL|JSON/);
            return true;
        });
        assert.deepEqual({ chat: f.ctx.chat, metadata: f.ctx.chatMetadata, nodes: [...f.nodes] }, before);
    });
}
