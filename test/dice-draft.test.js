import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiceDraft, mergeDiceDraft } from '../apps/dice/draft.js';
import { HISTORY_KEY } from '../apps/dice/service.js';
const record = { id: 'known', text: '【骰子 · 攻击 · #known】\n1d20 [14] = 14', results: [{ total: 14 }], settings: { mode: 'generic' }, createdAt: 10 };
const ctx = { chatMetadata: { [HISTORY_KEY]: { rolls: [record] } } };
test('rewrite can only change prose while exact known dice remain fixed', () => {
    const snapshot = splitDiceDraft('我攻击。\n' + record.text, ctx);
    assert.equal(snapshot.body, '我攻击。'); assert.deepEqual(snapshot.blocks, [{ id: 'known', text: record.text }]);
    assert.equal(mergeDiceDraft('我举剑挥向敌人。', snapshot), '我举剑挥向敌人。\n' + record.text);
    assert.equal(mergeDiceDraft('重写\n' + record.text, snapshot), '重写\n' + record.text);
});
test('similar unregistered text and another chat are never interpreted as fixed dice', () => {
    const text = '我写的【骰子 · 攻击 · #unknown】\n1d20 [20] = 20';
    assert.deepEqual(splitDiceDraft(text, ctx), { body: text, blocks: [] });
    assert.deepEqual(splitDiceDraft(record.text, { chatMetadata: {} }), { body: record.text, blocks: [] });
    assert.equal(mergeDiceDraft('  normal  \n', { blocks: [] }), '  normal  \n');
});
