// Reproducible synthetic size benchmark; it never reads local chats or private data.
// Run: node scripts/story-storage-benchmark.mjs
import assert from 'node:assert/strict';
import { createStoryStateGraph } from '../apps/shared/story-state-graph.js';
import { getReference, setReference, STORY_REFERENCE_KEY } from '../apps/shared/story-message-refs.js';

const byteLength = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const encode = new TextEncoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function syntheticArchive(length = 512 * 1024) {
    // Fixed seed, high-entropy ASCII, and no material from a real story.
    let seed = 0x4c575842;
    const chars = new Array(length);
    for (let i = 0; i < length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        chars[i] = alphabet[seed & 63];
    }
    return chars.join('');
}

const phrase = '这是一段完全虚构的测试剧情文本，仅用于测量每条消息的储存体积。';
const textBody = phrase.repeat(Math.ceil(6 * 1024 / encode.encode(phrase).byteLength));
const message = (floor, branch = '') => ({
    name: '合成角色',
    mes: `${floor}${branch ? `-${branch}` : ''}\n${textBody}`,
    is_user: false,
    extra: {},
});

const nodes = new Map();
let writes = 0;
const store = {
    async get(id) { return nodes.has(id) ? structuredClone(nodes.get(id)) : null; },
    async put(id, value) { writes++; nodes.set(id, structuredClone(value)); },
};
const graph = createStoryStateGraph(store);
const state = {
    archive: syntheticArchive(),
    world: { turn: 0, location: '测试场景' },
    characters: { alpha: { hp: 10, relation: '同伴' } },
};
const nodeBytes = () => [...nodes.values()].reduce((total, node) => total + byteLength(node), 0);
const messages = [], floorIds = [];
let parentStateId = null;
const initialStateBytes = byteLength(state);

for (let floor = 0; floor < 27; floor++) {
    state.world.turn = floor;
    const stateId = await graph.save(state, { parentId: parentStateId });
    const floorMessage = message(floor);
    setReference(floorMessage, stateId, { parentStateId });
    messages.push(floorMessage);
    floorIds.push(stateId);
    parentStateId = stateId;
}

const bytesAfterFloors = nodeBytes();
const branchParentId = floorIds[13];
const branchState = { ...state, world: { ...state.world, turn: 1_000 } };
const firstBranchId = await graph.save(branchState, { parentId: branchParentId });
const bytesAfterFirstBranch = nodeBytes();
const branchMessages = [];
for (let branch = 0; branch < 12; branch++) {
    const stateId = await graph.save(branchState, { parentId: branchParentId });
    assert.equal(stateId, firstBranchId);
    const branchMessage = message(13, `分支${branch + 1}`);
    setReference(branchMessage, stateId, { parentStateId: branchParentId });
    branchMessages.push(branchMessage);
}
const bytesAfterDuplicateBranches = nodeBytes();
assert.equal(bytesAfterDuplicateBranches - bytesAfterFirstBranch, 0);

const writesBeforeRead = writes;
for (let pass = 0; pass < 2; pass++) {
    for (const floor of [0, 13, 26]) {
        const reference = getReference(messages[floor], { parentStateId: floor ? floorIds[floor - 1] : null });
        assert.equal(reference.stateId, floorIds[floor]);
        assert.equal((await graph.load(reference.stateId)).world.turn, floor);
    }
    const reference = getReference(branchMessages[0], { parentStateId: branchParentId });
    assert.equal((await graph.load(reference.stateId)).world.turn, 1_000);
}
assert.equal(writes, writesBeforeRead);

const bytesBeforeUnchangedSave = nodeBytes();
assert.equal(await graph.save(state, { parentId: floorIds[26] }), floorIds[26]);
assert.equal(nodeBytes(), bytesBeforeUnchangedSave);

const allMessages = [...messages, ...branchMessages];
const result = {
    command: 'node scripts/story-storage-benchmark.mjs',
    scenario: {
        synthetic: true,
        floors: messages.length,
        branchesSharingOneParent: branchMessages.length,
        initialStateBytes,
        averageMessageBodyBytes: Math.round(allMessages.reduce((sum, item) => sum + encode.encode(item.mes).byteLength, 0) / allMessages.length),
    },
    bytes: {
        externalNodesAfterFloors: bytesAfterFloors,
        externalNodesAfterFirstBranch: bytesAfterFirstBranch,
        externalNodesAfterDuplicateBranches: bytesAfterDuplicateBranches,
        duplicateBranchAdditionalNodes: bytesAfterDuplicateBranches - bytesAfterFirstBranch,
        messageReferences: allMessages.reduce((sum, item) => sum + byteLength(item.extra[STORY_REFERENCE_KEY]), 0),
        allMessagesIncludingBody: allMessages.reduce((sum, item) => sum + byteLength(item), 0),
    },
    nodes: {
        total: nodes.size,
        checkpoints: [...nodes.values()].filter(node => node.kind === 'snapshot').length,
        deltas: [...nodes.values()].filter(node => node.kind === 'delta').length,
        writes,
    },
    checks: {
        duplicateBranchAddedNoNodeBytes: true,
        repeatedReadsWroteNothing: writes === writesBeforeRead,
        unchangedStateReusedId: true,
    },
};

console.log(JSON.stringify(result, null, 2));
