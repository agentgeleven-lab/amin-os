import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';

function fixture(options, missingThrows = false) {
    const nodes = new Map();
    let writes = 0;
    const reads = [];
    const store = {
        async get(id) {
            reads.push(id);
            if (nodes.has(id)) return structuredClone(nodes.get(id));
            if (missingThrows) throw Object.assign(new Error('not found'), { code: 'STORY_NOT_FOUND' });
            return null;
        },
        async put(id, value) { writes++; nodes.set(id, structuredClone(value)); },
    };
    return { graph: createStoryStateGraph(store, options), nodes, store, reads, get writes() { return writes; } };
}

const story = (hp, scene = '工坊') => ({
    characters: { 'HK416': { hp, mood: '稳定', biography: '追踪这条剧情线。'.repeat(80) } },
    scene: { name: scene, time: '第三天清晨' },
    inventory: ['接口校准仪', '调试终端'],
});

test('batch visits share validated parents and isolate each mutable callback result', async () => {
    const t = fixture();
    const base = await t.graph.save(story(10));
    const shared = await t.graph.save(story(9), { parentId: base });
    const left = await t.graph.save(story(8), { parentId: shared });
    const right = await t.graph.save(story(7), { parentId: shared });
    const expected = new Map([[left, story(8)], [right, story(7)], [shared, story(9)], [base, story(10)]]);
    const visited = [];
    t.reads.length = 0;
    await t.graph.visitMany([left, right, shared, base, right], async (state, id, error) => {
        assert.equal(error, null);
        assert.deepEqual(state, expected.get(id));
        await Promise.resolve();
        visited.push(id);
        // If a callback changes its result, subsequent roots/parents must
        // still use the validated original rather than the exposed object.
        state.characters.HK416.hp = -100;
        state.inventory.push('callback only');
    });
    assert.deepEqual(visited, [left, right, shared, base]);
    assert.deepEqual(t.reads, [left, shared, base, right]);
    assert.deepEqual(await t.graph.load(left), story(8));
});

test('batch visits revalidate changed parents on each call and recover after a failed call', async () => {
    const t = fixture();
    const base = await t.graph.save(story(10));
    const child = await t.graph.save(story(9), { parentId: base });
    const original = structuredClone(t.nodes.get(base));
    await t.graph.visitMany([child], state => assert.deepEqual(state, story(9)));
    t.nodes.get(base).state.characters.HK416.hp = 999;
    t.reads.length = 0;
    await assert.rejects(t.graph.visitMany([child], () => assert.fail('corrupt state exposed')),
        { code: 'STORY_STATE_CORRUPT' });
    assert.deepEqual(t.reads, [child, base]);
    t.nodes.set(base, original);
    t.reads.length = 0;
    await t.graph.visitMany([child], state => assert.deepEqual(state, story(9)));
    assert.deepEqual(t.reads, [child, base]);
});

test('settled batch visits report missing and corrupt chains independently and continue', async () => {
    const t = fixture(undefined, true);
    const base = await t.graph.save(story(10));
    const left = await t.graph.save(story(9), { parentId: base });
    const right = await t.graph.save(story(8), { parentId: base });
    const healthy = await t.graph.save(story(20));
    const missing = `sha256:${'f'.repeat(64)}`;
    t.nodes.get(base).state.characters.HK416.hp = 999;
    t.reads.length = 0;
    const outcomes = [];
    await t.graph.visitMany([left, healthy, right, missing], (state, id, error) => {
        outcomes.push([id, error?.code ?? null]);
        if (error) assert.equal(state, undefined);
        else assert.deepEqual(state, story(20));
    }, { settled: true });
    assert.deepEqual(outcomes, [[left, 'STORY_STATE_CORRUPT'], [healthy, null],
        [right, 'STORY_STATE_CORRUPT'], [missing, 'STORY_STATE_MISSING']]);
    assert.deepEqual(t.reads, [left, base, healthy, right, base, missing]);
});

test('batch visits fail fast by default and never swallow callback errors', async () => {
    const t = fixture();
    const healthy = await t.graph.save(story(10));
    const missing = `sha256:${'f'.repeat(64)}`;
    t.reads.length = 0;
    await assert.rejects(t.graph.visitMany([missing, healthy], () => assert.fail('unexpected visit')),
        { code: 'STORY_STATE_MISSING' });
    assert.deepEqual(t.reads, [missing]);
    const consumerError = new Error('consumer cancelled');
    for (const first of [healthy, missing]) {
        t.reads.length = 0;
        await assert.rejects(t.graph.visitMany([first, healthy], async () => {
            throw consumerError;
        }, { settled: true }), error => error === consumerError);
        assert.deepEqual(t.reads, [first]);
    }
});

test('batch parent cache evicts older records after 64 nodes', async () => {
    const t = fixture();
    const base = await t.graph.save(story(10));
    const child = await t.graph.save(story(9), { parentId: base });
    const others = [];
    for (let value = 0; value < 64; value++) others.push(await t.graph.save({ value }));
    t.reads.length = 0;
    let visits = 0;
    await t.graph.visitMany([base, ...others, child], (state, id) => {
        visits++;
        if (id === child) assert.deepEqual(state, story(9));
    });
    assert.equal(visits, 66);
    assert.equal(t.reads.filter(id => id === base).length, 2);
    assert.equal(t.reads.length, 67);
});

test('states larger than the batch cache budget still load without being retained', async () => {
    const maxBytes = new TextEncoder().encode(JSON.stringify(story(10))).byteLength + 100;
    const t = fixture({ maxBytes });
    const base = await t.graph.save(story(10));
    const left = await t.graph.save(story(9), { parentId: base });
    const right = await t.graph.save(story(8), { parentId: base });
    t.reads.length = 0;
    const states = [];
    await t.graph.visitMany([left, right], state => states.push(state));
    assert.deepEqual(states, [story(9), story(8)]);
    assert.deepEqual(t.reads, [left, base, right, base]);
});

test('batch visits validate their input and enforce the configured entry limit', async () => {
    const t = fixture({ maxEntries: 2 });
    const id = `sha256:${'f'.repeat(64)}`;
    await assert.rejects(t.graph.visitMany(id, () => {}), TypeError);
    await assert.rejects(t.graph.visitMany([], null), TypeError);
    await assert.rejects(t.graph.visitMany([id, id, id], () => {}), { code: 'STORY_STATE_INVALID' });
    await assert.rejects(t.graph.visitMany(['invalid'], () => {}), { code: 'STORY_STATE_INVALID' });
    await t.graph.visitMany([], () => assert.fail('empty batch visited'));
    assert.deepEqual(t.reads, []);
});

test('existing save and import nodes are read once while their parents remain validated', async () => {
    const t = fixture();
    const base = await t.graph.save(story(10));
    const child = await t.graph.save(story(9), { parentId: base });
    const bundle = await t.graph.exportClosure([child]);
    t.reads.length = 0;
    assert.equal(await t.graph.save(story(9)), child);
    assert.deepEqual(t.reads, [child, base]);
    t.reads.length = 0;
    await t.graph.importClosure(bundle);
    assert.deepEqual(t.reads, [base, child, base]);
    assert.equal(t.writes, 2);

    // A previous successful operation must not hide a changed ancestor.
    t.nodes.get(base).state.characters.HK416.hp = 999;
    t.reads.length = 0;
    await assert.rejects(t.graph.save(story(9)), { code: 'STORY_STATE_CORRUPT' });
    assert.deepEqual(t.reads, [child, base]);
    await assert.rejects(t.graph.importClosure(bundle), { code: 'STORY_STATE_CORRUPT' });
    assert.equal(t.writes, 2);
});

test('unchanged states reuse parent ID and different branches share the same ancestors', async () => {
    const t = fixture();
    const base = await t.graph.save(story(10));
    assert.equal(await t.graph.save(story(10), { parentId: base }), base);
    const left = await t.graph.save(story(8), { parentId: base });
    const right = await t.graph.save(story(9), { parentId: base });
    assert.equal(t.writes, 3);
    assert.equal(t.nodes.get(left).kind, 'delta');
    assert.equal(t.nodes.get(right).parentId, base);
    assert.deepEqual(await t.graph.load(base), story(10));
    assert.deepEqual(await t.graph.load(left), story(8));
    assert.deepEqual(await t.graph.load(right), story(9));
    assert.equal(await t.graph.save(story(8), { parentId: right }), left);
    assert.equal(t.writes, 3);
});

test('checkpoint depth is bounded and data stays exact through multiple edits', async () => {
    const t = fixture({ maxDeltaDepth: 2 });
    let parent = await t.graph.save(story(10));
    for (const hp of [9, 8, 7, 6]) {
        parent = await t.graph.save(story(hp), { parentId: parent });
        assert.deepEqual(await t.graph.load(parent), story(hp));
    }
    assert.equal(t.nodes.size, 5);
    assert.deepEqual([...t.nodes.values()].map(node => [node.kind, node.depth]),
        [['snapshot', 0], ['delta', 1], ['delta', 2], ['snapshot', 0], ['delta', 1]]);
});

test('exports the transitive closure and imports it before resolving a prior floor', async () => {
    const source = fixture();
    const base = await source.graph.save(story(10));
    const left = await source.graph.save(story(8), { parentId: base });
    const right = await source.graph.save(story(9), { parentId: base });
    const bundle = await source.graph.exportClosure([left, right]);
    assert.deepEqual(bundle.roots, [left, right]);
    assert.equal(Object.keys(bundle.nodes).length, 3);
    const target = fixture();
    await target.graph.importClosure(bundle);
    assert.deepEqual(await target.graph.load(left), story(8));
    assert.deepEqual(await target.graph.load(right), story(9));
    const writes = target.writes;
    await target.graph.importClosure(bundle);
    assert.equal(target.writes, writes);
});

test('a concurrent write of the same state through another parent is accepted only after validation', async () => {
    const original = fixture();
    const originalParent = await original.graph.save(story(10));
    const sameState = await original.graph.save(story(9), { parentId: originalParent });
    const alternative = fixture();
    const alternativeParent = await alternative.graph.save(story(8));
    alternative.nodes.set(originalParent, structuredClone(original.nodes.get(originalParent)));
    const contendedStore = {
        async get(id) { return alternative.nodes.get(id) ?? null; },
        async put(id) {
            if (id === sameState) {
                alternative.nodes.set(id, structuredClone(original.nodes.get(id)));
                throw Object.assign(new Error('conflict'), { code: 'STORY_CONFLICT' });
            }
            throw Error('unexpected write');
        },
    };
    const graph = createStoryStateGraph(contendedStore);
    assert.equal(await graph.save(story(9), { parentId: alternativeParent }), sameState);
    assert.deepEqual(await graph.load(sameState), story(9));
});

test('missing and damaged state files fail closed without substituting the latest state', async () => {
    const t = fixture(undefined, true);
    const base = await t.graph.save(story(10));
    const next = await t.graph.save(story(9), { parentId: base });
    t.nodes.delete(base);
    await assert.rejects(t.graph.load(next), { code: 'STORY_STATE_MISSING' });
    await assert.rejects(t.graph.save(story(8), { parentId: base }), { code: 'STORY_STATE_MISSING' });
    assert.equal(t.writes, 2);
    const x = fixture();
    const first = await x.graph.save(story(10));
    x.nodes.get(first).state.characters.HK416.hp = 999;
    await assert.rejects(x.graph.load(first), { code: 'STORY_STATE_CORRUPT' });
    await assert.rejects(x.graph.save(story(10)), { code: 'STORY_STATE_CORRUPT' });
    const y = fixture();
    const ancestor = await y.graph.save(story(10));
    const child = await y.graph.save(story(9), { parentId: ancestor });
    y.nodes.get(child).changes[0].value = -100;
    await assert.rejects(y.graph.load(child), { code: 'STORY_STATE_CORRUPT' });
});

test('unsafe object keys and malformed import bundles cannot write state files', async () => {
    const t = fixture();
    const malicious = JSON.parse('{"characters":{"__proto__":{"polluted":true}}}');
    await assert.rejects(t.graph.save(malicious), { code: 'STORY_STATE_INVALID' });
    assert.equal(t.writes, 0);
    const clean = fixture();
    const id = await clean.graph.save(story(10));
    const bundle = await clean.graph.exportClosure([id]);
    bundle.nodes[id].state.characters.HK416.hp = -100;
    await assert.rejects(t.graph.importClosure(bundle), { code: 'STORY_STATE_CORRUPT' });
    assert.equal(t.writes, 0);
    assert.equal({}.polluted, undefined);
});
