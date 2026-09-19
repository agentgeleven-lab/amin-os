// Uninstall migration only; no retired application runtime is retained.
// Run before services cache localStorage. Exact namespaces only, never clear().
export function cleanupRetiredData(storage, ctx) {
    const result = { removed: 0, updated: 0, errors: [] };
    const attempt = (key, fn) => { try { fn(); } catch { result.errors.push(key); } };
    const keys = [];
    attempt('storage enumeration', () => {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (typeof key === 'string') keys.push(key);
        }
    });
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const has = (v, key) => object(v) && Object.hasOwn(v, key);
    for (const key of keys) attempt(key, () => {
        if (key === 'amin_os_factions_v1' || key.startsWith('amin_os_factions_v1:')) {
            storage.removeItem(key); result.removed++; return;
        }
        const tiles = key === 'amin-os.tiles.v2' || key === 'amin-os.tiles.v1';
        const profiles = key.startsWith('dynamic-map.api-profiles:amin-os:');
        if (!tiles && !profiles) return;
        const value = JSON.parse(storage.getItem(key));
        let changed = false;
        if (tiles) {
            const list = key === 'amin-os.tiles.v1' ? value : value?.version === 2 ? value.tiles : null;
            if (Array.isArray(list)) {
                const filtered = list.filter(t => t?.id !== 'factions' && t?.target !== 'factions');
                changed = filtered.length !== list.length;
                if (changed) {
                    storage.setItem(key, JSON.stringify(key === 'amin-os.tiles.v1' ? filtered : { ...value, tiles: filtered }));
                    result.updated++;
                }
            }
        } else if (has(value?.bindings, 'app:factions')) {
            delete value.bindings['app:factions'];
            storage.setItem(key, JSON.stringify(value)); result.updated++;
        }
    });
    attempt('appearance settings', () => {
        const appearance = ctx?.extensionSettings?.amin_os_appearance_v1;
        const owners = [appearance?.apps, appearance?.floor?.buttons, appearance?.floor?.overrides];
        if (!owners.some(owner => has(owner, 'factions'))) return;
        for (const owner of owners) if (has(owner, 'factions')) delete owner.factions;
        ctx.saveSettingsDebounced?.(); result.updated++;
    });
    attempt('retired prompt', () => ctx?.setExtensionPrompt?.('amin-os-factions-follow', '', 1, 0, false));
    return result;
}
