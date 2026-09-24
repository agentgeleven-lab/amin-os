// Synthetic, offline idle-sync benchmark. No SillyTavern host, timers, or real saves.
// Usage: node scripts/performance-audit.mjs [--root /path/to/amin-os]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--root')) throw Error('Usage: node scripts/performance-audit.mjs [--root /path/to/amin-os]');
const selfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = args.length ? path.resolve(args[1]) : selfRoot;
const fromRoot = relative => path.join(root, relative);
const load = relative => import(pathToFileURL(fromRoot(relative)).href);
const sources = ['apps/characters/service.js', 'apps/inventory/service.js', 'apps/relationships/service.js', 'apps/scene/service.js', 'apps/status/history.js'];
for (const file of [...sources, 'package.json']) if (!fs.existsSync(fromRoot(file))) throw Error(`Target is not an Amin OS checkout: ${fromRoot(file)}`);
const sourceHash = createHash('sha256');
for (const file of sources) sourceHash.update(file).update(fs.readFileSync(fromRoot(file)));
const pkg = JSON.parse(fs.readFileSync(fromRoot('package.json'), 'utf8'));

const [charactersService, inventoryService, relationshipsService, sceneService, historyModule,
    charactersModel, inventoryModel, relationshipsModel, sceneModel] = await Promise.all([
    'apps/characters/service.js', 'apps/inventory/service.js', 'apps/relationships/service.js',
    'apps/scene/service.js', 'apps/status/history.js', 'apps/characters/model.js',
    'apps/inventory/model.js', 'apps/relationships/model.js', 'apps/scene/model.js',
].map(load));

const perSize = [{ messages: 100, iterations: 25 }, { messages: 1000, iterations: 20 }, { messages: 5000, iterations: 12 }];
const warmups = 4;
const bytesPerMessage = 2048;
const at = '2026-09-24T00:00:00.000Z';
const seedText = 'A synthetic roleplay scene with no user content. ';
function syntheticMessage(index) {
    const prefix = `${String(index).padStart(6, '0')}:`;
    const mes = prefix + seedText.repeat(Math.ceil((bytesPerMessage - prefix.length) / seedText.length)).slice(0, bytesPerMessage - prefix.length);
    assert.equal(mes.length, bytesPerMessage);
    return { name: index % 2 ? 'Narrator' : 'User', is_user: index % 2 === 0, mes, swipe_id: 0,
        extra: { wsh_message_id: `synthetic-${index}` } };
}
function percentile(values, percent) {
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(ordered.length * percent / 100) - 1)];
}
function stats(samples) {
    return { n: samples.length, p50Ms: +percentile(samples, 50).toFixed(3), p95Ms: +percentile(samples, 95).toFixed(3),
        minMs: +Math.min(...samples).toFixed(3), maxMs: +Math.max(...samples).toFixed(3) };
}
function fixture(messageCount) {
    const counters = { metadataSaves: 0, chatSaves: 0, promptCalls: 0, notifications: { characters: 0, inventory: 0, relationships: 0, scene: 0, history: 0 } };
    const ctx = {
        chatId: 'synthetic-chat', getCurrentChatId() { return this.chatId; },
        characterId: 0, groupId: null, characters: [{ avatar: 'synthetic.png' }],
        chat: [], chatMetadata: { variables: {} },
        saveMetadata() { counters.metadataSaves++; return Promise.resolve(); },
        saveMetadataDebounced() { counters.metadataSaves++; },
        saveChat() { counters.chatSaves++; return Promise.resolve(); },
        setExtensionPrompt() { counters.promptCalls++; },
    };
    const persons = [{ id: 'alice', name: 'Alice', kind: 'npc', notes: '', stats: [] },
        { id: 'bob', name: 'Bob', kind: 'npc', notes: '', stats: [] }];
    ctx.chatMetadata[charactersModel.KEY] = charactersModel.buildRestore(ctx,
        { version: 1, characters: persons }, { id: 'seed-characters', at });
    ctx.chatMetadata[inventoryModel.KEY] = inventoryModel.buildRestoreStore(ctx,
        inventoryModel.emptyState(), { id: 'seed-inventory', at });
    ctx.chatMetadata[relationshipsModel.KEY] = relationshipsModel.buildRestore(ctx,
        relationshipsModel.emptyState(), { id: 'seed-relationships', at });
    const scene = sceneModel.emptyState();
    ctx.chatMetadata[sceneModel.KEY] = sceneModel.appendEvent(sceneModel.emptyStore(), [],
        { op: 'restore', reason: 'synthetic baseline', state: scene, details: { beforeTime: null, afterTime: null } },
        { eventId: 'seed-scene', at });
    ctx.chat = Array.from({ length: messageCount }, (_, index) => syntheticMessage(index));
    return { ctx, counters };
}

function measureSize({ messages, iterations }) {
    const { ctx, counters } = fixture(messages), getContext = () => ctx;
    const services = {
        characters: charactersService.createCharactersService(getContext, { poll: false }),
        inventory: inventoryService.createInventoryService(getContext, { poll: false }),
        relationships: relationshipsService.createRelationshipsService(getContext, { poll: false }),
        scene: sceneService.createSceneService(getContext, { poll: false }),
    };
    const history = historyModule.createHistory({ context: getContext, read: () => ({ 版本: 1, 项目: {} }), write() {},
        nativeState: () => ({ managed: true, ready: true }), changed() { counters.notifications.history++; } });
    const remove = Object.entries(services).map(([name, service]) => service.subscribe(() => { counters.notifications[name]++; }));
    const names = Object.keys(services), samples = { combined: [], history: [], ...Object.fromEntries(names.map(name => [name, []])) };
    try {
        // Seed history and allow JIT warmup before observations. All persistence
        // methods are counters only; history's persist:false forbids autosave.
        for (let index = 0; index < warmups; index++) {
            for (const name of names) services[name].sync();
            history.sync({ persist: false });
        }
        for (const key of Object.keys(counters.notifications)) counters.notifications[key] = 0;
        counters.metadataSaves = counters.chatSaves = counters.promptCalls = 0;
        const heapBefore = process.memoryUsage().heapUsed;
        for (let index = 0; index < iterations; index++) {
            const combinedStart = performance.now();
            for (const name of names) {
                const start = performance.now(); services[name].sync();
                samples[name].push(performance.now() - start);
            }
            samples.combined.push(performance.now() - combinedStart);
            const historyStart = performance.now(); history.sync({ persist: false });
            samples.history.push(performance.now() - historyStart);
        }
        const heapAfter = process.memoryUsage().heapUsed;
        assert.equal(counters.metadataSaves, 0, 'Idle sync unexpectedly saved metadata');
        assert.equal(counters.chatSaves, 0, 'Idle sync unexpectedly saved chat');
        assert.deepEqual(counters.notifications, { characters: 0, inventory: 0, relationships: 0, scene: 0, history: 0 }, 'Idle sync unexpectedly notified a view');
        return { messages, messageChars: bytesPerMessage, approximateChatMiB: +(messages * bytesPerMessage / 1048576).toFixed(2),
            warmups, iterations, idleCombined: stats(samples.combined), idleHistory: stats(samples.history),
            services: Object.fromEntries(names.map(name => [name, stats(samples[name])])),
            sideEffects: { ...counters, notifications: { ...counters.notifications } },
            heapDeltaMiB: +((heapAfter - heapBefore) / 1048576).toFixed(2) };
    } finally {
        for (const off of remove) off();
        for (const service of Object.values(services)) service.dispose();
        history.dispose();
    }
}

const result = {
    kind: 'synthetic-offline-node-idle-sync',
    caveat: 'This measures service sync CPU time in Node with generated messages. It does not measure SillyTavern host latency or UI frame rate.',
    target: { root, packageVersion: pkg.version, serviceSourceSha256: sourceHash.digest('hex') },
    machine: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
        logicalCpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? '', totalMemoryGiB: +(os.totalmem() / 1073741824).toFixed(1) },
    fixture: { generated: true, messageChars: bytesPerMessage, content: 'deterministic synthetic text', appStores: 'valid model-built baseline at chat root; two characters, empty inventory/relationships/scene', poll: false },
    sizes: perSize.map(measureSize),
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
