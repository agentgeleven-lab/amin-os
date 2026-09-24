import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRevision } from '../apps/shared/chat-revision.js';

test('idle revisions stay stable but edits to any old message and swipe invalidate them', () => {
    const chat = [{ name: 'User', is_user: true, mes: 'old' }, { name: 'Actor', mes: 'latest' }];
    let revision = chatRevision(chat);
    assert.equal(chatRevision(chat), revision);
    for (const [key, value] of [['mes','edited'], ['name','Other'], ['is_user',false], ['swipe_id',1]]) {
        chat[0][key] = value;
        const next = chatRevision(chat);
        assert.notEqual(next, revision); revision = next;
        assert.equal(chatRevision(chat), next);
    }
    chat[0].extra = { unrelated: true };
    assert.equal(chatRevision(chat), revision);
});

test('appends, truncation, reordered messages, and cloned branch arrays invalidate revisions', () => {
    const chat = [{ mes: 'a' }, { mes: 'b' }];
    let revision = chatRevision(chat);
    for (const mutate of [() => chat.push({mes:'c'}), () => chat.pop(), () => chat.reverse()]) {
        mutate(); const next = chatRevision(chat); assert.notEqual(next, revision); revision = next;
    }
    assert.notEqual(chatRevision(structuredClone(chat)), revision);
    chat[0].mes = 'temporary'; const temporary = chatRevision(chat);
    chat[0].mes = 'b'; assert.notEqual(chatRevision(chat), temporary);
});

test('malformed message arrays cannot reuse a previous valid revision', () => {
    const chat = [{mes:'a'}]; chatRevision(chat); chat[0] = null;
    assert.throws(() => chatRevision(chat), /不兼容/);
    assert.throws(() => chatRevision({}), /不兼容/);
});
