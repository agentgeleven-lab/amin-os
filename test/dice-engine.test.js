import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula, evaluateFormula, normalizeConfig, randomInt, percentile, cocOutcome, rollCoc, rollDnd, rollBatch, formatRoll } from '../apps/dice/engine.js';
const rng = (...values) => { let i = 0; return () => { if (i >= values.length) throw Error('Test RNG exhausted'); return values[i++]; }; };
test('safe formula parser handles multiple terms, signed constants, keep and negative dice', () => {
    const r = evaluateFormula('4D6kh3 + 1d4 - 2 - d8', rng(1, 4, 4, 6, 3, 8));
    assert.equal(r.formula, '4d6kh3+1d4-2-1d8'); assert.equal(r.total, 7); assert.deepEqual(r.terms[0].kept, [1, 2, 3]);
    assert.equal(evaluateFormula('3d6kl2', rng(4, 1, 1)).total, 2);
    assert.equal(evaluateFormula('-1d6+3', rng(6)).total, -3);
});
test('formula rejects injection, missing operators, dangling signs and work exceeding limits', () => {
    for (const value of ['eval(1)', '1d6;alert(1)', '2d6**2', '1d6++2', '1d6+', '1d6d8', '0d6', '1d1', '101d6', '1d1000001', '4d6kh5', '4d6kl0', '9999999999999d6', '12', '{{roll::20}}']) assert.throws(() => parseFormula(value), undefined, value);
    assert.throws(() => normalizeConfig({ formula: '100d6', batch: 5 }));
    assert.throws(() => normalizeConfig({ formula: 'd6', batch: '1.2' }));
    assert.throws(() => normalizeConfig({ label: '{{roll::20}}' }));
    assert.throws(() => normalizeConfig({ mode: 'dnd', dc: 'oops' }));
    assert.throws(() => normalizeConfig({ mode: 'coc', skill: 0 }));
});
test('crypto sampling rejects modulo tail instead of biasing non-power-of-two dice', () => {
    let calls = 0; const fake = { getRandomValues(a) { a[0] = calls++ === 0 ? 0xffffffff : 5; return a; } };
    assert.equal(randomInt(6, fake), 6); assert.equal(calls, 2);
    assert.equal(randomInt(20, { getRandomValues: a => { a[0] = 0; } }), 1);
    assert.throws(() => randomInt(6, {}), /随机/);
    assert.throws(() => randomInt(6, { getRandomValues: a => { a[0] = 0xffffffff; } }), /随机/);
});
test('D&D preserves both candidates and applies selected natural-die policy only to kept die', () => {
    const advantage = rollDnd({ advantage: 'advantage', modifier: 3, dc: 15 }, rng(1, 14));
    assert.equal(advantage.natural, 14); assert.equal(advantage.total, 17); assert.equal(advantage.success, true); assert.deepEqual(advantage.dice, [1, 14]);
    const disadvantage = rollDnd({ advantage: 'disadvantage', critical: 'attack', modifier: 90, dc: 10 }, rng(20, 1));
    assert.equal(disadvantage.natural, 1); assert.equal(disadvantage.success, false);
    assert.equal(rollDnd({ modifier: -10, dc: 15 }, rng(20)).success, false);
    assert.equal(rollDnd({ modifier: 30, dc: 15 }, rng(1)).success, true);
    assert.equal(rollDnd({ critical: 'attack', modifier: -10, dc: 40 }, rng(20)).success, true);
    assert.equal(rollDnd({ dc: '' }, rng(18)).success, null);
    assert.equal(rollDnd({ critical: 'house', dc: '' }, rng(1)).success, false);
});
test('percentile zero convention is applied before bonus/penalty candidate selection', () => {
    assert.equal(percentile(0, 0), 100); assert.equal(percentile(0, 3), 3); assert.equal(percentile(3, 0), 30);
    const bonus = rollCoc({ skill: 50, bonus: 1 }, rng(1, 1, 4));
    assert.deepEqual(bonus.candidates, [100, 30]); assert.equal(bonus.total, 30); assert.equal(bonus.units, 0);
    const penalty = rollCoc({ skill: 50, penalty: 1 }, rng(1, 1, 4)); assert.equal(penalty.total, 100); assert.equal(penalty.level, 'fumble');
    const cancelled = rollCoc({ skill: 50, bonus: 2, penalty: 2 }, rng(5, 3)); assert.deepEqual(cancelled.candidates, [24]); assert.equal(cancelled.net, 0);
});
test('CoC levels, selected difficulty and fumble chance remain separate at boundaries', () => {
    assert.equal(cocOutcome(1, 1, 'extreme').level, 'critical'); assert.equal(cocOutcome(1, 1, 'extreme').success, true);
    assert.equal(cocOutcome(10, 51).level, 'extreme'); assert.equal(cocOutcome(11, 51).level, 'hard');
    assert.equal(cocOutcome(25, 51).level, 'hard'); assert.equal(cocOutcome(26, 51).level, 'regular');
    assert.equal(cocOutcome(40, 60, 'hard').level, 'regular'); assert.equal(cocOutcome(40, 60, 'hard').success, false);
    assert.equal(cocOutcome(95, 49).level, 'failure'); assert.equal(cocOutcome(96, 49).level, 'fumble');
    assert.equal(cocOutcome(96, 50).level, 'failure'); assert.equal(cocOutcome(99, 50).level, 'failure'); assert.equal(cocOutcome(100, 100).level, 'fumble');
    assert.equal(cocOutcome(96, 55, 'hard').level, 'fumble'); assert.equal(cocOutcome(96, 100, 'hard').level, 'regular');
    assert.equal(cocOutcome(96, 250, 'extreme').level, 'hard');
});
test('batch validates all work before consuming random numbers and snapshots readable results', () => {
    let calls = 0; assert.throws(() => rollBatch({ formula: '100d6', batch: 5 }, () => ++calls)); assert.equal(calls, 0);
    const batch = rollBatch({ formula: '2d6+1', label: '伤害', batch: 2 }, rng(2, 3, 4, 5)); assert.deepEqual(batch.results.map(r => r.total), [6, 10]);
    const text = formatRoll({ id: '12345678-abcd-eeee-ffff-123456789000', ...batch }); assert.match(text, /#12345678abcd/); assert.match(text, /1\. 2d6/); assert.match(text, /= 10/);
});
