import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chatRevisions, messageRevision, pathBelongs, sameMessageRevision, validMessageRevision } from '../apps/shared/message-revision.js';
import { chatPath as characterPath, currentState as charactersAt, emptyStore as emptyCharacters } from '../apps/characters/model.js';
import { chatPath as scenePath, currentState as sceneAt, emptyState as emptyScene } from '../apps/scene/model.js';

const oldRevision = message => JSON.stringify([message.name ?? '', !!message.is_user, message.mes ?? '', message.swipe_id ?? 0]);
const message = (mes, swipe_id = 0) => ({ name: '角色', is_user: false, mes, swipe_id });

test('new revision is bounded SHA-256 of the exact former message tuple', () => {
    const row = message('很长的正文🌙'.repeat(10000));
    const expected = createHash('sha256').update(oldRevision(row), 'utf8').digest('hex');
    assert.equal(messageRevision(row), `sha256:${expected}`);
    assert.equal(characterPath([row])[0], messageRevision(row));
    assert.equal(scenePath([row])[0], messageRevision(row));
    assert.ok(JSON.stringify(chatRevisions([row])).length < 80);
});

test('edits to each existing identity field invalidate cached revisions', () => {
    const row = message('正文');
    const first = messageRevision(row);
    row.name = '另一个角色'; const renamed = messageRevision(row); assert.notEqual(renamed, first);
    row.is_user = true; const user = messageRevision(row); assert.notEqual(user, renamed);
    row.mes = '改写正文'; const edited = messageRevision(row); assert.notEqual(edited, user);
    row.swipe_id = 1; assert.notEqual(messageRevision(row), edited);
});

test('old full-body paths and new compact paths match only the same branch', () => {
    const ancestor = message('此前消息'), current = message('当前消息');
    const old = [oldRevision(ancestor), oldRevision(current)];
    const compact = chatRevisions([ancestor, current]);
    assert.equal(pathBelongs(old, compact), true);
    assert.equal(pathBelongs(compact, old), true);
    assert.equal(pathBelongs([old[0], compact[1]], compact), true);
    assert.equal(pathBelongs(old.slice(0, 1), compact), true);
    assert.equal(pathBelongs(old, compact.slice(0, 1)), false);
    for (const changed of [message('当前消息', 1), message('改写消息')]) {
        assert.equal(pathBelongs(old, chatRevisions([ancestor, changed])), false);
        assert.equal(pathBelongs(compact, [old[0], oldRevision(changed)]), false);
    }
    assert.equal(validMessageRevision('sha256:zz'), false);
    assert.equal(validMessageRevision('["x",false,"y",-1]'), false);
    assert.equal(sameMessageRevision('bad', 'bad'), false);
});

test('existing history still replays after compact revisions are introduced', () => {
    const initial = message('第一楼'), later = message('第二楼');
    const characters = emptyCharacters();
    const first = { version: 1, characters: [{ id: 'a', name: '甲', kind: 'pc', notes: '', stats: [] }] };
    const second = { version: 1, characters: [{ id: 'b', name: '乙', kind: 'npc', notes: '', stats: [] }] };
    characters.events.push({ id: 'first', at: '2026-09-24', path: [oldRevision(initial)], snapshot: first });
    characters.events.push({ id: 'second', at: '2026-09-24', path: chatRevisions([initial, later]), snapshot: second });
    assert.deepEqual(charactersAt(characters, [initial]), first);
    assert.deepEqual(charactersAt(characters, [initial, later]), second);
    assert.deepEqual(charactersAt(characters, [initial, message('different')]), first);
    assert.deepEqual(charactersAt(characters, [message('changed')]), { version: 1, characters: [] });

    const savedScene = emptyScene(); savedScene.settings.includeInContext = true;
    const scene = { version: 1, events: [{ path: [oldRevision(initial)], snapshot: savedScene }] };
    assert.deepEqual(sceneAt(scene, [initial, later]), savedScene);
    assert.deepEqual(sceneAt(scene, [message('changed')]), emptyScene());
});
