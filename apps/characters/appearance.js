import { getCharacter } from './model.js';
import { readInventory, WEAR_SLOTS, WEAR_LAYERS } from '../inventory/model.js';

/** Clothing is always derived from canonical inventory records, never copied into a character. */
export function readCharacterAppearance(ctx, characterId) {
    const character = getCharacter(ctx, characterId);
    if (!character) throw Error('人物已不存在于当前剧情分支。');
    const inventory = readInventory(ctx);
    return {
        characterId,
        appearance: structuredClone(character.appearance ?? { description: '', hairstyle: '', features: '' }),
        worn: inventory.items.filter(item => item.ownerId === characterId && item.equipped && item.quantity > 0).map(item => ({
            itemId: item.id, name: item.name, slot: item.wear?.slot ?? '', layer: item.wear?.layer ?? '',
            slotLabel: WEAR_SLOTS[item.wear?.slot] ?? '未指定部位', layerLabel: WEAR_LAYERS[item.wear?.layer] ?? '',
            description: item.wear?.description ?? '', condition: structuredClone(item.condition ?? { wetness: 0, dirt: 0, damage: 0, notes: '' }),
        })),
    };
}
