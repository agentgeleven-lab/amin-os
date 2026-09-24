import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

test('synthetic 27-floor storage benchmark stays bounded and repeated branches add no nodes', async () => {
    const script = fileURLToPath(new URL('../scripts/story-storage-benchmark.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [script], { timeout: 30_000, maxBuffer: 1_000_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.scenario.synthetic, true);
    assert.equal(result.scenario.floors, 27);
    assert.equal(result.scenario.branchesSharingOneParent, 12);
    assert.equal(result.nodes.total, 28);
    assert.equal(result.nodes.checkpoints + result.nodes.deltas, result.nodes.total);
    assert.equal(result.bytes.duplicateBranchAdditionalNodes, 0);
    assert.equal(result.checks.repeatedReadsWroteNothing, true);
    assert.equal(result.checks.unchangedStateReusedId, true);
    assert.ok(result.bytes.externalNodesAfterFloors < result.scenario.initialStateBytes * 10);
    assert.ok(result.bytes.messageReferences < result.bytes.allMessagesIncludingBody / 5);
});
