import { getCharacter } from './model.js';
import { readInventory } from '../inventory/model.js';
import { resolveRelationships } from '../relationships/model.js';
import { readCharacterMemories } from '../journal/model.js';
import { readCurrentScene, scheduleForecast, formatGameTime } from '../scene/model.js';

/** Derived only: ownership and presence require explicit character IDs, never names. */
export function readCharacterOverview(ctx, characterId) {
    if (!getCharacter(ctx, characterId)) throw Error('人物已不存在于当前剧情分支。');
    const errors = [];
    const read = (label, callback, fallback) => {
        try { return callback(); } catch (error) { errors.push(`${label}：${error.message}`); return fallback; }
    };
    const inventory = read('资产', () => readInventory(ctx), { items: [], balances: [] });
    const relationships = read('关系', () => resolveRelationships(ctx).filter(item => item.fromId === characterId || item.toId === characterId), []);
    const memories = read('记忆', () => readCharacterMemories(ctx, characterId), []);
    const scene = read('场景', () => {
        const state = readCurrentScene(ctx), active = state.scenes[state.activeSceneId];
        return { time: formatGameTime(state.clock, state.periods), present: active?.participantIds.includes(characterId) ? active : null };
    }, null);
    const schedules = read('日程', () => scheduleForecast(ctx).filter(item => item.characterId === characterId), []);
    return { items: inventory.items.filter(item => item.ownerId === characterId), balances: inventory.balances.filter(item => item.ownerId === characterId), relationships, memories, scene, schedules, errors };
}
