import { adapter as characters } from './adapters/characters.js';
import { adapter as inventory } from './adapters/inventory.js';
import { adapter as relationships } from './adapters/relationships.js';
import { adapter as scene } from './adapters/scene.js';
import { adapter as journal } from './adapters/journal.js';
import { adapter as effects } from './adapters/effects.js';
import { adapter as map } from './adapters/map.js';
import { adapter as status } from './adapters/status.js';
import { adapter as organizations } from './adapters/organizations.js';
import { adapter as information } from './adapters/information.js';
import { adapter as dice } from './adapters/dice.js';

export const adapters = Object.freeze([characters, inventory, relationships, scene, journal, effects, map, status, organizations, information, dice]);
export const getAdapter = id => adapters.find(adapter => adapter.id === id);
export const adapterPaths = () => [...new Map(adapters.flatMap(adapter => adapter.paths).map(path => [JSON.stringify(path), path])).values()];
