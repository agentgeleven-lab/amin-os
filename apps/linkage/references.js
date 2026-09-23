// A derived index: identity and values remain owned by their original app.
export function buildReferenceIndex(data = {}, manualLinks = []) {
    const entities = [], links = [], seen = new Set();
    const add = (module, id, label) => {
        if (id == null || id === '') return;
        const key = `${module}:${id}`;
        if (!seen.has(key)) { seen.add(key); entities.push({ id: key, module, label: String(label ?? id) }); }
        return key;
    };
    const link = (from, module, id, label) => { if (from && id != null && id !== '') links.push({ from, to: `${module}:${id}`, label }); };
    const people = data.characters?.characters ?? [];
    for (const p of people) {
        const key = add('characters', p.id, p.name);
        for (const stat of p.stats ?? []) {
            const statKey=add('characters',`${p.id}/stats/${stat.id}`,`${p.name} · ${stat.label}`);
            if(stat.binding)link(statKey,'status',stat.binding,'数值绑定');
            link(key,'characters',`${p.id}/stats/${stat.id}`,'人物属性');
        }
    }
    const status = data.status?.项目 ?? data.status?.document?.项目 ?? {};
    for (const [project, fields] of Object.entries(status)) for (const name of Object.keys(fields ?? {})) add('status', `${project}.${name}`, `${project} · ${name}`);
    for (const item of data.inventory?.items ?? []) { const key = add('inventory', item.id, item.name); link(key, 'characters', item.ownerId, item.equipped ? '穿戴/装备者' : '持有者'); }
    for (const balance of data.inventory?.balances ?? []) { const key = add('inventory', balance.id, balance.name); link(key, 'characters', balance.ownerId, '资源所属人物'); }
    for (const relation of data.relationships?.relationships ?? []) {
        const key = add('relationships', relation.id, relation.label || relation.type);
        link(key, 'characters', relation.fromId, '关系发起者'); link(key, 'characters', relation.toId, '关系对象');
    }
    const maps = data.map?.maps ?? data.map?.document?.maps ?? {};
    for (const [mapId, map] of Object.entries(maps)) {
        add('map', mapId, map.name ?? mapId);
        for (const [nodeId, node] of Object.entries(map.nodes ?? {})) add('map', `${mapId}/${node.id ?? nodeId}`, node.name ?? node.label ?? nodeId);
    }
    for (const [id, scene] of Object.entries(data.scene?.scenes ?? {})) {
        const key = add('scene', scene.id ?? id, scene.name);
        for (const person of scene.participantIds ?? []) link(key, 'characters', person, '实际在场');
        const location = scene.location ?? scene.mapRef ?? scene;
        if (location?.mapId && location?.nodeId) link(key, 'map', `${location.mapId}/${location.nodeId}`, '所在地点');
    }
    for (const schedule of data.scene?.schedules ?? []) {
        const key = add('scene', schedule.id, schedule.name ?? '日程');
        link(key, 'characters', schedule.characterId, '日程人物');
        if (schedule.mapId && schedule.nodeId) link(key, 'map', `${schedule.mapId}/${schedule.nodeId}`, '预计地点');
    }
    for (const entry of data.journal?.entries ?? []) {
        const key = add('journal', entry.id, entry.title);
        for (const id of entry.characterIds ?? []) link(key, 'characters', id, '关联人物');
        link(key, 'characters', entry.characterId ?? entry.knowerId, '知情人物');
        link(key, 'characters', entry.learnedFromId, '获知来源人物');
        link(key, 'journal', entry.factId, '所知事实');
    }
    for (const effect of data.effects?.effects ?? []) {
        const key = add('effects', effect.id, effect.name ?? effect.title);
        link(key, 'characters', effect.characterId ?? effect.targetId, '作用人物');
        for (const operation of effect.periodic?.operations ?? []) {
            link(key, 'characters', operation.characterId, '周期结算人物');
            if(operation.characterId&&operation.statId)link(key,'characters',`${operation.characterId}/stats/${operation.statId}`,'周期数值绑定');
            link(key, 'inventory', operation.itemId ?? operation.balanceId, '周期结算资源');
        }
    }
    const org = data.organizations?.doc ?? data.organizations ?? {};
    for (const group of ['organizations','alliances','regions']) for (const [id, value] of Object.entries(org[group] ?? {})) add('organizations', id, value.name ?? id);
    for (const record of data.information?.records ?? []) {
        add('information',record.id,record.title??record.name);
        for(const field of record.fields??[])add('information',`${record.id}/fields/${field.id}`,`${record.name} · ${field.label}`);
    }
    for (const roll of data.dice?.rolls ?? []) add('dice', roll.id, roll.settings?.label ?? roll.id);
    for (const value of manualLinks) links.push({ ...value, manual:true });
    return { entities, links, unresolved: links.filter(item => !seen.has(item.from) || !seen.has(item.to)) };
}
