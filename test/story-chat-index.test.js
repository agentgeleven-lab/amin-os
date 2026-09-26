import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, candidateId, commitIdentities, indexedState, selectedCandidate, validateIndex,
    STORY_MESSAGE_ID, STORY_CANDIDATE_ID } from '../apps/shared/story-chat-index.js';
import { setReference, STORY_REFERENCE_KEY } from '../apps/shared/story-message-refs.js';

const stateId = n => `sha256:${n.toString(16).padStart(64, '0')}`;
const clone = value => structuredClone(value);
function message(n, swipes = 1) {
    const variants = Array.from({ length: swipes }, (_, i) => `消息 ${n} 候选 ${i}`);
    return { mes: variants[0], [STORY_MESSAGE_ID]: `m-${n}`, extra: { [STORY_CANDIDATE_ID]: `c-${n}-0` },
        ...(swipes > 1 ? { swipes: variants, swipe_id: 0,
            swipe_info: variants.map((_, i) => ({ extra: { [STORY_CANDIDATE_ID]: `c-${n}-${i}` } })) } : {}) };
}
function initial(chat) {
    const built = buildIndex(chat, 'parent');
    commitIdentities(chat, built.copies);
    for (const [floor, id] of Object.entries(built.index.order)) {
        for (const entry of Object.values(built.index.messages[id].candidates)) entry.stateId = stateId(Number(floor) * 10 + entry.swipe + 1);
    }
    return built.index;
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

test('a 5000-floor append copies only the appended message and reuses all existing index rows', () => {
    const chat = Array.from({ length: 5000 }, (_, n) => message(n, 3)), previous = freeze(initial(chat));
    // Existing messages are read-only here: commit must skip every reused one.
    chat.forEach(freeze);
    chat.push({ mes: '新回复' });
    const { index, copies } = buildIndex(chat, 'parent', previous, stateId(999));
    assert.equal(copies.filter((copy, floor) => copy !== chat[floor]).length, 1);
    assert.equal(Object.entries(previous.messages).filter(([id, row]) => index.messages[id] === row).length, 5000);
    assert.equal(chat.at(-1)[STORY_MESSAGE_ID], undefined, 'building cannot write live identities');
    commitIdentities(chat, copies);
    assert.ok(chat.at(-1)[STORY_MESSAGE_ID]);
    assert.equal(validateIndex(index), index);
});

test('unchanged captures snapshot only the tail and never mutate the previous candidate states', () => {
    const chat = [message(0, 2), message(1, 2)], previous = freeze(initial(chat));
    const { index, copies } = buildIndex(chat, 'parent', previous);
    assert.strictEqual(copies[0], chat[0]);
    assert.notStrictEqual(copies[1], chat[1]);
    assert.deepEqual(index, previous);
    assert.strictEqual(index.messages['m-0'], previous.messages['m-0']);
    for (const cid of Object.keys(previous.messages['m-1'].candidates)) {
        assert.notStrictEqual(index.messages['m-1'].candidates[cid], previous.messages['m-1'].candidates[cid]);
    }
    // The host may switch the live tail while an asynchronous state write runs.
    chat[1].swipe_id = 1; chat[1].mes = chat[1].swipes[1];
    chat[1].swipe_info[0].extra[STORY_CANDIDATE_ID] = 'live-replaced';
    assert.equal(candidateId(copies[1]), 'c-1-0');
    index.messages['m-1'].candidates['c-1-0'].stateId = stateId(888);
    assert.equal(previous.messages['m-1'].candidates['c-1-0'].stateId, stateId(11));
});

test('appended cloned Swipes rebuild one message and receive a fresh identity without stealing state', () => {
    const chat = Array.from({ length: 100 }, (_, n) => message(n, 2)), previous = freeze(initial(chat));
    const tail = chat.at(-1);
    tail.swipes.push('新的候选'); tail.swipe_info.push(clone(tail.swipe_info[0]));
    tail.swipe_id = 2; tail.mes = tail.swipes[2];
    const { index, copies } = buildIndex(chat, 'parent', previous);
    assert.equal(copies.filter((copy, floor) => copy !== chat[floor]).length, 1);
    assert.equal(Object.entries(previous.messages).filter(([id, row]) => index.messages[id] === row).length, 99);
    assert.equal(candidateId(tail), 'c-99-0', 'the live clone remains untouched before commit');
    const cid = candidateId(copies.at(-1));
    assert.notEqual(cid, 'c-99-0');
    assert.deepEqual(index.messages['m-99'].candidates[cid], { swipe: 2, stateId: null });
    commitIdentities(chat, copies);
    assert.equal(candidateId(tail), cid);
    assert.equal(indexedState(index, tail), null);
});

test('candidate selection, reorder and deletion rebuild the affected rows while retaining states by ID', () => {
    const chat = [message(0, 3), message(1, 2), message(2)], previous = freeze(initial(chat));
    chat[0].swipes.reverse(); chat[0].swipe_info.reverse(); chat[0].swipe_id = 1;
    chat[0].mes = chat[0].swipes[1];
    chat[1].swipes.shift(); chat[1].swipe_info.shift(); chat[1].mes = chat[1].swipes[0];
    const { index, copies } = buildIndex(chat, 'parent', previous);
    assert.deepEqual(index.messages['m-0'].candidates['c-0-2'], { swipe: 0, stateId: stateId(3) });
    assert.equal(index.messages['m-0'].selected, 1);
    assert.deepEqual(index.messages['m-1'].candidates, { 'c-1-1': { swipe: 0, stateId: stateId(12) } });
    commitIdentities(chat, copies);
    assert.equal(indexedState(index, chat[0]), stateId(2));
    assert.equal(indexedState(index, chat[1]), stateId(12));
});

test('floor deletion, insertion and movement rebuild order without guessing states from positions', () => {
    const original = [message(0), message(1), message(2), message(3)], previous = freeze(initial(original));
    const chat = [original[2], { mes: '插入消息', is_user: true }, original[0]];
    const { index, copies } = buildIndex(chat, 'parent', previous);
    assert.strictEqual(index.messages['m-2'], previous.messages['m-2']);
    assert.equal(index.order[0], 'm-2'); assert.equal(index.order[2], 'm-0');
    assert.equal(index.messages['m-1'], undefined); assert.equal(index.messages['m-3'], undefined);
    assert.equal(indexedState(index, copies[0]), stateId(21));
    assert.equal(indexedState(index, copies[1]), null);
    assert.equal(indexedState(index, copies[2]), stateId(1));
});

test('a truncated branch shares immutable historical rows and keeps its writable tail separate', () => {
    const chat = [message(0, 2), message(1, 2), message(2)], previous = freeze(initial(chat));
    const branch = clone(chat.slice(0, 2)), parentId = stateId(900);
    const { index, copies } = buildIndex(branch, 'branch', previous, parentId);
    assert.deepEqual(index.inheritedFrom, { chat: 'parent', indexId: parentId });
    assert.strictEqual(index.messages['m-0'], previous.messages['m-0']);
    assert.equal(index.messages['m-2'], undefined);
    index.messages['m-1'].candidates[candidateId(copies[1])].stateId = stateId(901);
    assert.equal(indexedState(previous, chat[1]), stateId(11));
    const next = buildIndex(branch, 'branch', index, stateId(902)).index;
    assert.deepEqual(next.inheritedFrom, index.inheritedFrom);
});

test('reused history still rejects duplicate or invalid message and existing Swipe identities', () => {
    const chat = [message(0, 2), message(1, 2)], previous = initial(chat);
    assert.throws(() => buildIndex([...chat, clone(chat[0])], 'parent', previous), /重复消息标识/);
    const invalidMessage = clone(chat); invalidMessage[0][STORY_MESSAGE_ID] = 'invalid.id';
    assert.throws(() => buildIndex(invalidMessage, 'parent', previous), /稳定标识无效/);
    const duplicateSwipe = clone(chat);
    duplicateSwipe[0].swipe_info[1].extra[STORY_CANDIDATE_ID] = 'c-0-0';
    const before = JSON.stringify(duplicateSwipe);
    assert.throws(() => buildIndex(duplicateSwipe, 'parent', previous), /重复 Swipe/);
    assert.equal(JSON.stringify(duplicateSwipe), before);
    const invalidSwipe = clone(chat); invalidSwipe[0].swipe_info[1].extra[STORY_CANDIDATE_ID] = 'invalid.id';
    assert.throws(() => buildIndex(invalidSwipe, 'parent', previous), /Swipe 稳定标识无效/);
    const incomplete = clone(chat); incomplete[1].mes = '流式更新中';
    assert.throws(() => selectedCandidate(buildIndex(incomplete, 'parent', previous).copies[1]), /尚未保存完整/);
});

test('legacy pointers and a lazy first Swipe still migrate without mutating the source', () => {
    const legacy = { mes: '最初回复' }; setReference(legacy, stateId(100));
    const migrated = buildIndex([legacy], 'parent');
    assert.ok(legacy.extra[STORY_REFERENCE_KEY]);
    assert.equal(indexedState(migrated.index, migrated.copies[0]), stateId(100));
    commitIdentities([legacy], migrated.copies);
    const cid = candidateId(legacy);
    legacy.swipes = [legacy.mes, '下一候选']; legacy.swipe_info = [{ extra: {} }, { extra: {} }];
    legacy.swipe_id = 1; legacy.mes = legacy.swipes[1];
    const rebuilt = buildIndex([legacy], 'parent', migrated.index);
    assert.equal(candidateId(rebuilt.copies[0], 0), cid);
    assert.equal(rebuilt.index.messages[legacy[STORY_MESSAGE_ID]].candidates[cid].stateId, stateId(100));
    assert.equal(indexedState(rebuilt.index, rebuilt.copies[0]), null);
    assert.equal(legacy.swipe_info[0].extra[STORY_CANDIDATE_ID], undefined);
});
