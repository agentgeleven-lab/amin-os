const MODES = new Set(['amin', 'tavern-current', 'tavern-profile']);

export function createHostRoutes(storage, namespace) {
    const key = `amin-os.host-routes:${namespace}`;
    let bindings = {};
    try {
        const saved = JSON.parse(storage.getItem(key) || '{}');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) bindings = saved;
    } catch { /* Keep old AI settings usable when this optional setting is malformed. */ }
    const normalize = value => {
        const mode = value?.mode;
        return MODES.has(mode) ? { mode, profileId: mode === 'tavern-profile' && typeof value.profileId === 'string' ? value.profileId : '' } : { mode: 'amin', profileId: '' };
    };
    return {
        get(appId) { return normalize(bindings[appId]); },
        set(appId, value) {
            if (!appId || !MODES.has(value?.mode)) throw Error('未知的酒馆生成方式');
            if (value.mode === 'tavern-profile' && (typeof value.profileId !== 'string' || !value.profileId)) throw Error('请选择酒馆连接配置');
            bindings = { ...bindings, [appId]: normalize(value) };
            storage.setItem(key, JSON.stringify(bindings));
            return this.get(appId);
        },
    };
}
