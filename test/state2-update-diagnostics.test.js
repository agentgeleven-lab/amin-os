import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateDiagnostics } from '../apps/state2/update-diagnostics.js';

test('diagnostics compare only managed fields and never mutate input or execute updates', () => {
    const d = createUpdateDiagnostics({ roots: ['状态栏'] });
    const before = { 状态栏: JSON.stringify({ hp: 10, mana: 2 }), unrelated: 'secret-chat' };
    d.begin({ variables: before, index: 2, swipe: 1 });
    const result = d.finish({ variables: { 状态栏: JSON.stringify({ hp: 7, new: true }), unrelated: 'changed' }, receivedState: true });
    assert.equal(result.outcome, 'changed'); assert.equal(result.index, 2); assert.equal(result.swipe, 1);
    assert.deepEqual(result.changes, [{ path: '状态栏.hp', before: '10', after: '7' }, { path: '状态栏.mana', before: '2', after: '（已删除）' }, { path: '状态栏.new', before: '（不存在）', after: 'true' }]);
    assert.equal(before.状态栏, '{"hp":10,"mana":2}'); assert.doesNotMatch(JSON.stringify(result), /secret-chat|unrelated/);
});

test('received block, missing block, native errors and absent baselines are distinguished', () => {
    const d = createUpdateDiagnostics({ roots: ['x'] });
    d.begin({ variables: { x: '1' } }); assert.equal(d.finish({ variables: { x: '1' }, receivedState: true }).outcome, 'state-without-change');
    d.begin({ variables: { x: '1' } }); assert.equal(d.finish({ variables: { x: '1' } }).outcome, 'no-state');
    assert.equal(d.finish({ variables: { x: '2' } }).outcome, 'unknown');
    d.begin({ variables: { x: '1' } }); const error = d.finish({ variables: { x: '2' }, errors: ['token=secret-value Bearer abcdefg'] });
    assert.equal(error.outcome, 'native-error'); assert.doesNotMatch(error.errors[0], /secret-value|abcdefg/);
});

test('large records are bounded, sensitive fields omitted, returned history detached and clear removes baseline', () => {
    const d = createUpdateDiagnostics({ roots: ['x'], maxRecords: 2 });
    for (let i = 0; i < 3; i++) {
        d.begin({ variables: { x: '{}' } });
        const result = d.finish({ variables: { x: { ...Object.fromEntries(Array.from({ length: 100 }, (_, k) => [k, 'a'.repeat(500)])), apiKey: 'private' } } });
        assert.equal(result.changes.length, 40); assert.ok(result.warnings.length); assert.ok(result.changes.every(c => c.after.length <= 240));
        assert.doesNotMatch(JSON.stringify(result), /private/);
    }
    assert.equal(d.records().length, 2); const copy = d.records(); copy[0].changes.length = 0; assert.equal(d.records()[0].changes.length, 40);
    d.begin({ variables: { x: '1' } }); d.clear(); assert.deepEqual(d.records(), []);
    assert.equal(d.finish({ variables: { x: '2' } }).outcome, 'unknown');
});

test('an oversized unreadable root does not produce false deletion changes', () => {
    const d = createUpdateDiagnostics({ roots: ['x'] });
    d.begin({ variables: { x: '{"hp":5}' } });
    const result = d.finish({ variables: { x: 'a'.repeat(300001) }, receivedState: true });
    assert.deepEqual(result.changes, []); assert.ok(result.warnings.length);
});
