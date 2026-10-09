import test from 'node:test';
import assert from 'node:assert/strict';
import { planCandidateIdentityRepair } from '../apps/shared/story-identity-recovery.js';

const state = n => `sha256:${String(n).padStart(64, '0')}`;
function fixture() {
    const source = {
        name: 'assistant', is_user: false, is_system: false,
        mes: 'second candidate', swipe_id: 1, swipes: ['first candidate', 'second candidate'],
        amin_story_message_id: 'message-a',
        extra: { amin_story_candidate_id: 'candidate-b', unrelated: 'keep' },
        swipe_info: [{ extra: { amin_story_candidate_id: 'candidate-a', legacy: 'keep-a' } }, { extra: { amin_story_candidate_id: 'candidate-b' } }],
        variables: [{ privateVariable: 10 }, { privateVariable: 20 }], send_date: 'unchanged-date',
    };
    const index = {
        kind: 'amin-story-index', version: 1, chat: 'chat', inheritedFrom: null,
        order: { 0: 'message-a' }, messages: { 'message-a': {
            selected: 1, candidates: { 'candidate-a': { swipe: 0, stateId: state(1) }, 'candidate-b': { swipe: 1, stateId: state(2) } },
        } },
    };
    const current = structuredClone(source);
    current.swipe_info[0].extra.amin_story_candidate_id = 'candidate-b';
    return { chat: [current], sourceChat: [source], sourceIndex: index, currentIndex: structuredClone(index) };
}
const plan = f => planCandidateIdentityRepair(f.chat, f.sourceChat, f.sourceIndex, f.currentIndex);
function unchanged(f, action) {
    const before = structuredClone(f);
    action();
    assert.deepEqual(f, before, 'planning must leave all chat, variable and index data unchanged');
}

test('candidate identity plan restores duplicate IDs by message and candidate body without mutation', () => {
    const f = fixture();
    unchanged(f, () => assert.deepEqual(plan(f), { version: 1, rows: [
        { floor: 0, swipe: 0, oldId: 'candidate-b', newId: 'candidate-a', stateId: state(1) },
    ], mirrors: [] }));
});

test('candidate identity plan restores missing and invalid IDs and the selected mirror', () => {
    const f = fixture();
    delete f.chat[0].swipe_info[0].extra.amin_story_candidate_id;
    f.chat[0].swipe_info[1].extra.amin_story_candidate_id = 'invalid id';
    f.chat[0].extra.amin_story_candidate_id = 'invalid id';
    unchanged(f, () => {
        const result = plan(f);
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[0].oldId, undefined);
        assert.deepEqual(result.mirrors, [{ floor: 0, oldId: 'invalid id', newId: 'candidate-b' }]);
    });
});

test('candidate identity plan repairs a stale selected mirror without changing healthy slot IDs', () => {
    const f = fixture();
    f.chat[0] = structuredClone(f.sourceChat[0]);
    f.chat[0].extra.amin_story_candidate_id = 'candidate-a';
    assert.deepEqual(plan(f), { version: 1, rows: [], mirrors: [
        { floor: 0, oldId: 'candidate-a', newId: 'candidate-b' },
    ] });
});

test('healthy edited candidates and additional healthy messages are not matched or changed', () => {
    const f = fixture();
    f.chat[0] = structuredClone(f.sourceChat[0]);
    f.chat[0].mes = f.chat[0].swipes[1] = 'an intentionally edited healthy reply';
    f.chat.push({ name: 'user', is_user: true, mes: 'new healthy message', amin_story_message_id: 'new-message', extra: { amin_story_candidate_id: 'new-candidate' } });
    unchanged(f, () => assert.deepEqual(plan(f), { version: 1, rows: [], mirrors: [] }));
});

test('reordered candidates retain states by original candidate identity, not current ordinal', () => {
    const f = fixture(), message = f.chat[0];
    message.swipes.reverse();
    message.mes = message.swipes[1];
    message.swipe_info = [{ extra: {} }, { extra: {} }];
    f.currentIndex.messages['message-a'].candidates['candidate-a'].stateId = state(11);
    f.currentIndex.messages['message-a'].candidates['candidate-b'].stateId = state(22);
    const result = plan(f);
    assert.deepEqual(result.rows, [
        { floor: 0, swipe: 0, oldId: undefined, newId: 'candidate-b', stateId: state(22) },
        { floor: 0, swipe: 1, oldId: undefined, newId: 'candidate-a', stateId: state(11) },
    ]);
    assert.deepEqual(result.mirrors, [{ floor: 0, oldId: 'candidate-b', newId: 'candidate-a' }]);
});

test('deleted source candidates do not force ordinal restoration of remaining slots', () => {
    const f = fixture(), message = f.chat[0];
    message.swipes = ['second candidate'];
    message.swipe_info = [{ extra: {} }];
    message.swipe_id = 0;
    assert.deepEqual(plan(f), { version: 1, rows: [
        { floor: 0, swipe: 0, oldId: undefined, newId: 'candidate-b', stateId: state(2) },
    ], mirrors: [] });
});

for (const label of ['chat', 'sourceChat']) {
    test(`candidate identity plan rejects duplicate message IDs in ${label}`, () => {
        const f = fixture();
        f[label].push(structuredClone(f[label][0]));
        unchanged(f, () => assert.throws(() => plan(f), /重复消息标识/));
    });
}

test('candidate identity plan rejects missing original message or original candidate match', () => {
    const missing = fixture();
    missing.sourceChat[0].amin_story_message_id = 'other-message';
    assert.throws(() => plan(missing), /原始备份没有同一消息/);
    const edited = fixture();
    edited.chat[0].swipes[0] = 'different body';
    unchanged(edited, () => assert.throws(() => plan(edited), /正文无法唯一匹配/));
    const changedRole = fixture();
    changedRole.chat[0].is_system = true;
    assert.throws(() => plan(changedRole), /正文无法唯一匹配/);
});

for (const label of ['chat', 'sourceChat']) {
    test(`candidate identity plan rejects ambiguous candidate bodies in ${label}`, () => {
        const f = fixture();
        f[label][0].swipes[0] = 'second candidate';
        unchanged(f, () => assert.throws(() => plan(f), /相同候选正文/));
    });
}

test('candidate identity plan rejects invalid original identities and incompatible index mappings', () => {
    const invalid = fixture();
    invalid.sourceChat[0].swipe_info[0].extra.amin_story_candidate_id = 'candidate-b';
    assert.throws(() => plan(invalid), /候选标识缺失或重复/);
    const wrongOrdinal = fixture();
    wrongOrdinal.sourceIndex.messages['message-a'].candidates['candidate-a'].swipe = 1;
    assert.throws(() => plan(wrongOrdinal), /Swipe 关联不一致/);
    const missingCid = fixture();
    delete missingCid.currentIndex.messages['message-a'].candidates['candidate-a'];
    assert.throws(() => plan(missingCid), /当前索引没有原始候选标识/);
    const missingRow = fixture();
    missingRow.currentIndex.messages = {};
    missingRow.currentIndex.order = {};
    assert.throws(() => plan(missingRow), /索引没有待修复消息/);
});

for (const label of ['chat', 'sourceChat']) {
    test(`candidate identity plan refuses incomplete selected candidates in ${label}`, () => {
        const f = fixture();
        f[label][0].mes = 'unfinished candidate';
        unchanged(f, () => assert.throws(() => plan(f), /尚未保存完整/));
    });
}

test('an unsafe later affected message rejects the complete repair plan', () => {
    const f = fixture(), later = structuredClone(f.chat[0]);
    later.amin_story_message_id = 'unmatched-later-message';
    f.chat.push(later);
    unchanged(f, () => assert.throws(() => plan(f), /原始备份没有同一消息/));
});

function locatedFixture(sourcePrefix = 2, currentPrefix = 2) {
    const f = fixture();
    const prefixes = Array.from({ length: Math.max(sourcePrefix, currentPrefix) }, (_, i) => ({
        name: 'user', is_user: true, mes: `healthy prefix ${i}`,
        amin_story_message_id: `prefix-message-${i}`, extra: { amin_story_candidate_id: `prefix-candidate-${i}` },
    }));
    f.sourceChat = [...structuredClone(prefixes.slice(0, sourcePrefix)), ...f.sourceChat];
    f.chat = [...structuredClone(prefixes.slice(0, currentPrefix)), ...f.chat];
    for (const [index, chat] of [[f.sourceIndex, f.sourceChat], [f.currentIndex, f.chat]]) {
        index.order = {};
        for (const [floor, message] of chat.entries()) {
            const id = message.amin_story_message_id;
            index.order[floor] = id;
            if (id !== 'message-a') index.messages[id] = { selected: 0, candidates: {
                [message.extra.amin_story_candidate_id]: { swipe: 0, stateId: state(100 + floor) },
            } };
        }
    }
    return f;
}

function assertLocatedError(f, expected, detail) {
    unchanged(f, () => assert.throws(() => plan(f), error => {
        assert.equal(error.source, expected.source);
        assert.equal(error.floor, expected.floor);
        if (expected.field !== undefined) assert.equal(error.field, expected.field);
        if (expected.swipe !== undefined) {
            assert.equal(error.swipe, expected.swipe);
            assert.match(error.message, new RegExp(`Swipe\\s*${expected.swipe + 1}(?:\\D|$)`));
        }
        if (expected.code) assert.equal(error.code, expected.code);
        assert.match(error.message, expected.source === 'original' ? /原聊天文件/ : /当前聊天/);
        assert.match(error.message, new RegExp(`第\\s*${expected.floor + 1}\\s*楼`));
        if (detail) assert.match(error.message, detail);
        return true;
    }));
}

const malformedUnselected = {
    null: { mutate: message => { message.swipes[0] = null; }, detail: /null|空值/i },
    sparse: { mutate: message => { delete message.swipes[0]; }, detail: /缺失|空位|不存在|undefined/i },
    number: { mutate: message => { message.swipes[0] = 17; }, detail: /number|数字|数值/i },
    undefined: { mutate: message => { message.swipes[0] = undefined; }, detail: /缺失|不存在|undefined/i },
};
for (const [label, source] of [['chat', 'current'], ['sourceChat', 'original']]) {
    for (const [kind, malformed] of Object.entries(malformedUnselected)) {
        test(`candidate diagnostics locate ${kind} unselected Swipe in the ${source} third floor`, () => {
            const f = locatedFixture();
            malformed.mutate(f[label][2]);
            assert.equal(f[label][2].swipe_id, 1);
            assertLocatedError(f, { source, floor: 2, swipe: 0, field: 'swipes' }, malformed.detail);
        });
    }

    test(`selected candidate mismatch retains its error code and ${source} floor/Swipe location`, () => {
        const f = locatedFixture();
        f[label][2].mes = 'selected body does not match';
        assertLocatedError(f, { source, floor: 2, swipe: 1, field: 'mes', code: 'INCOMPLETE_CANDIDATE' },
            /不一致|不匹配|不同|尚未保存完整/);
    });

    for (const [kind, mutate, detail] of [
        ['null', message => { message.mes = null; }, /null|空值/i],
        ['missing', message => { delete message.mes; }, /缺失|不存在|undefined/i],
        ['number', message => { message.mes = 23; }, /number|数字|数值/i],
    ]) {
        test(`candidate diagnostics distinguish ${kind} mes in the ${source} third floor`, () => {
            const f = locatedFixture(); mutate(f[label][2]);
            assertLocatedError(f, { source, floor: 2, field: 'mes' }, detail);
        });
    }

    test(`candidate diagnostics locate invalid swipe_id in the ${source} third floor`, () => {
        const f = locatedFixture();
        f[label][2].swipe_id = -1;
        assertLocatedError(f, { source, floor: 2, field: 'swipe_id' }, /编号|swipe_id/i);
    });
}

test('all original rows are validated first and report their original position when current chat order differs', () => {
    const f = locatedFixture(2, 1);
    f.sourceChat[2].swipes[0] = null;
    f.chat[1].swipes[0] = 29;
    assertLocatedError(f, { source: 'original', floor: 2, swipe: 0, field: 'swipes' }, /null|空值/i);
});

test('candidate body matching failure points to the current position rather than the original file position', () => {
    const f = locatedFixture(2, 1);
    f.chat[1].swipes[0] = 'edited body absent from original';
    assertLocatedError(f, { source: 'current', floor: 1, swipe: 0 }, /正文无法唯一匹配/);
});
