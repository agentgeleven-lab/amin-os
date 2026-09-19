import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRetiredData } from '../retired-data.js';
import { defaultTiles, loadTiles, TILE_KEY } from '../tile-layout.js';
import { AI_APPS } from '../ai/service.js';
function harness(entries = {}) {
    const data = new Map(Object.entries(entries)), writes = [];
    const storage = {
        get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
        getItem: k => data.get(k) ?? null,
        setItem: (k, v) => { writes.push(k); data.set(k, v); },
        removeItem: k => { writes.push(k); data.delete(k); },
    };
    return { data, storage, writes };
}
test('uninstall removes every retired chat key but preserves unrelated and similarly named data', () => {
    const h = harness({ amin_os_factions_v1: 'bad json', 'amin_os_factions_v1:|a|chat-a': 'a', 'amin_os_factions_v1:|b|chat-b': 'b', amin_os_factions_v10: 'keep', other: 'untouched' });
    const result = cleanupRetiredData(h.storage);
    assert.equal(result.removed, 3); assert.deepEqual(result.errors, []);
    assert.deepEqual([...h.data], [['amin_os_factions_v10', 'keep'], ['other', 'untouched']]);
    const count = h.writes.length; cleanupRetiredData(h.storage); assert.equal(h.writes.length, count);
});
test('uninstall removes retired custom tiles without changing other custom layouts or metadata', () => {
    const kept = { id: 'custom-map', target: 'map', size: 'wide', label: 'My map', image: 'abc' };
    const h = harness({ [TILE_KEY]: JSON.stringify({ version: 2, extra: 'preserve', tiles: [kept, { id: 'x', target: 'factions' }] }), 'amin-os.tiles.v1': JSON.stringify([{ id: 'status', size: 'wide' }, { id: 'factions' }]) });
    cleanupRetiredData(h.storage);
    assert.deepEqual(JSON.parse(h.data.get(TILE_KEY)), { version: 2, extra: 'preserve', tiles: [kept] });
    assert.deepEqual(JSON.parse(h.data.get('amin-os.tiles.v1')), [{ id: 'status', size: 'wide' }]);
    assert.ok(!defaultTiles().some(t => t.target === 'factions'));
    assert.ok(!AI_APPS.some(a => a.id === 'factions'));
    assert.ok(!loadTiles(h.storage).some(t => t.target === 'factions'));
});
test('uninstall removes only retired binding and appearance overrides, never shared API profiles', () => {
    const key = 'dynamic-map.api-profiles:amin-os:namespace';
    const value = { profiles: [{ id: 'shared', apiKey: 'retained' }], bindings: { 'app:factions': 'shared', 'app:map': 'shared' } };
    const h = harness({ [key]: JSON.stringify(value), 'dynamic-map.api-profiles:other': JSON.stringify(value) });
    let saved = 0; const prompts = [];
    const ctx = { extensionSettings: { amin_os_appearance_v1: { apps: { factions: {}, map: { theme: 'mint' } }, global: { theme: 'paper' } } }, saveSettingsDebounced: () => saved++, setExtensionPrompt: (...args) => prompts.push(args) };
    cleanupRetiredData(h.storage, ctx);
    assert.deepEqual(JSON.parse(h.data.get(key)), { profiles: value.profiles, bindings: { 'app:map': 'shared' } });
    assert.equal(h.data.get('dynamic-map.api-profiles:other'), JSON.stringify(value));
    assert.deepEqual(ctx.extensionSettings.amin_os_appearance_v1, { apps: { map: { theme: 'mint' } }, global: { theme: 'paper' } });
    assert.equal(saved, 1); assert.equal(prompts[0][0], 'amin-os-factions-follow'); assert.equal(prompts[0][1], '');
});
test('uninstall leaves corrupt shared data untouched and continues with exact retired keys', () => {
    const h = harness({ [TILE_KEY]: '{bad', 'amin_os_factions_v1:chat': 'remove', 'dynamic-map.api-profiles:amin-os:x': 'null' });
    const result = cleanupRetiredData(h.storage);
    assert.deepEqual(result.errors, [TILE_KEY]); assert.equal(h.data.get(TILE_KEY), '{bad');
    assert.equal(h.data.has('amin_os_factions_v1:chat'), false);
});
test('storage errors are reported without blocking the remaining application startup', () => {
    const storage = { get length() { throw Error('denied'); } };
    assert.deepEqual(cleanupRetiredData(storage).errors, ['storage enumeration']);
});
