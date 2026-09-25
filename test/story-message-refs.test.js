import test from 'node:test';
import assert from 'node:assert/strict';
import { getReference, setReference, STORY_REFERENCE_KEY, StoryReferenceError } from '../apps/shared/story-message-refs.js';

const state = char => `sha256:${char.repeat(64)}`;
const code = expected => error => error instanceof StoryReferenceError && error.code === expected;
const candidate = () => ({
    name: '旁白', is_user: false, mes: '她选择左侧的门。', swipe_id: 0,
    extra: { custom: 'keep' },
    swipes: ['她选择左侧的门。', '她选择右侧的门。'],
    swipe_info: [{ extra: { custom: 'keep' } }, { extra: { alternate: 'keep' } }],
});

test('a message stores a short pointer and preserves unrelated data across a branch copy', () => {
    const message = { name: '玩家', is_user: true, mes: '前往旧城。', extra: { unrelated: 3 } };
    assert.equal(getReference(message), null);
    const reference = setReference(message, state('a'));
    assert.equal(reference.stateId, state('a'));
    assert.equal(reference.parentStateId, null);
    assert.equal(getReference(structuredClone(message)).stateId, state('a'));
    assert.equal(message.extra.unrelated, 3);
    assert.ok(!JSON.stringify(message.extra[STORY_REFERENCE_KEY]).includes(message.mes));
    assert.ok(JSON.stringify(message.extra[STORY_REFERENCE_KEY]).length < 400);
});

test('a selected swipe carries its own reference and switching does not reuse the former swipe', () => {
    const message = candidate();
    setReference(message, state('a'));
    assert.equal(getReference(message).stateId, state('a'));
    assert.equal(message.swipe_info[0].extra[STORY_REFERENCE_KEY].stateId, state('a'));
    assert.equal(message.swipe_info[1].extra[STORY_REFERENCE_KEY], undefined);

    // TauriTavern syncSwipeToMes replaces the top-level extra on selection.
    message.swipe_id = 1;
    message.mes = message.swipes[1];
    message.extra = structuredClone(message.swipe_info[1].extra);
    assert.equal(getReference(message), null);
    setReference(message, state('b'), { parentStateId: state('a') });
    assert.equal(getReference(message, { parentStateId: state('a') }).stateId, state('b'));
    assert.throws(() => getReference(message, { parentStateId: state('c') }), code('PARENT_MISMATCH'));

    message.swipe_id = 0;
    message.mes = message.swipes[0];
    message.extra = structuredClone(message.swipe_info[0].extra);
    assert.equal(getReference(message).stateId, state('a'));
    assert.equal(message.swipe_info[1].extra.alternate, 'keep');
});

test('edited text, wrong swipe and unfinished generated candidate fail closed', () => {
    const message = candidate();
    setReference(message, state('a'));
    message.mes = '她选择了第三扇门。';
    assert.throws(() => getReference(message), code('INCOMPLETE_CANDIDATE'));
    assert.throws(() => setReference(message, state('b')), code('INCOMPLETE_CANDIDATE'));
    message.swipes[0] = message.mes;
    assert.throws(() => getReference(message), code('STALE_REFERENCE'));

    const old = candidate();
    setReference(old, state('a'));
    // A new swipe can temporarily clone the old top-level extra.
    old.swipe_id = 1;
    old.mes = old.swipes[1];
    assert.equal(getReference(old), null);
    old.swipe_info[1].extra[STORY_REFERENCE_KEY] = structuredClone(old.extra[STORY_REFERENCE_KEY]);
    assert.throws(() => getReference(old), code('INVALID_REFERENCE'));
});

test('malformed and missing references are distinct', () => {
    const message = { name: '旁白', mes: '醒来', extra: {} };
    assert.equal(getReference(message), null);
    message.extra[STORY_REFERENCE_KEY] = { stateId: '../../chat' };
    assert.throws(() => getReference(message), code('INVALID_REFERENCE'));
    assert.throws(() => setReference(message, '../chat'), code('INVALID_STATE_ID'));
});


test('new references tolerate display-name changes but still reject changed story text',()=>{
 const m=candidate();setReference(m,state('a'));m.name='新的显示名';assert.equal(getReference(m).stateId,state('a'));
 m.mes='另一件事情';m.swipes[0]=m.mes;assert.throws(()=>getReference(m),code('STALE_REFERENCE'));
});
test('legacy references stay readable and do not gain an automatic stale bypass',()=>{
 const m=candidate();setReference(m,state('a'));delete m.swipe_info[0].extra[STORY_REFERENCE_KEY].contentHash;
 assert.equal(getReference(m).stateId,state('a'));m.name='改名';assert.throws(()=>getReference(m),code('STALE_REFERENCE'));
});
