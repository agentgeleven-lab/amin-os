import { KEY, readStore, readInventory, change as applyInventory } from '../../inventory/model.js';
import { KEY as CHARACTERS_KEY, readCharacters, validId } from '../../characters/model.js';

const fields = {
    'create-item': ['name', 'ownerId', 'quantity', 'equipped', 'notes', 'wear', 'condition'],
    'save-item': ['name', 'quantity', 'equipped', 'notes', 'wear', 'condition'],
    'delete-item': [], 'consume-item': ['quantity'], 'transfer-item': ['quantity', 'toOwnerId', 'newId'],
    'equip-item': ['equipped'], 'set-condition': ['condition'],
    'create-balance': ['name', 'ownerId', 'amount', 'unit', 'notes'],
    'save-balance': ['name', 'amount', 'unit', 'notes'], 'delete-balance': [],
    'adjust-balance': ['delta'], 'transfer-balance': ['amount', 'toOwnerId', 'newId'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const adapter = {
    id: 'inventory', label: '背包、穿戴与账本', paths: [[KEY], [CHARACTERS_KEY]],
    contract: 'target=稳定物品/资源ID。create-item: data={name,ownerId,quantity:非负整数,equipped?:boolean,notes?,wear?:{slot:""|"head"|"face"|"neck"|"torso"|"hands"|"waist"|"legs"|"feet"|"back"|"accessory",layer:"base"|"middle"|"outer",description?},condition?:{wetness:0..100整数,dirt:0..100整数,damage:0..100整数,notes?}}；save-item: 同上可选字段，不得修改ownerId；consume-item: {quantity:正整数}；transfer-item: {quantity,toOwnerId,newId?}；equip-item: {equipped:boolean}；set-condition: {condition:{wetness?,dirt?,damage?,notes?}}；delete-item: {}仅零数量。create-balance: {name,ownerId,amount:非负数,unit?,notes?}；save-balance: 同上可选字段，不得修改ownerId；adjust-balance: {delta:非零收支数字}；transfer-balance: {amount:正数,toOwnerId,newId?}；delete-balance: {}仅零余额。金额最多六位小数且0..1000000000。创建target/newId必须显式安全ID，转交普通物品或创建目标资源账户需要newId。指定部位衣物须逐件登记(quantity<=1)，转交保留原itemID；同人物同部位同层次仅一件装备，换装先卸下后穿上。状态不得凭空生成，依据已发生剧情。',
    read: ctx => readInventory(ctx),
    apply(ctx, change, { operationId, now }) {
        const allowed = fields[change.action], data = change.data;
        if (!allowed || !object(data) || Object.keys(data).some(key => !allowed.includes(key))) throw Error('背包联动操作或参数无效。');
        if (typeof change.reason !== 'string' || !change.reason.trim()) throw Error('背包更新需要剧情原因。');
        const state = readInventory(ctx), creating = change.action.startsWith('create-');
        const isItem = change.action.includes('item') || change.action === 'set-condition';
        const records = isItem ? state.items : state.balances, existing = records.find(record => record.id === change.target);
        if (creating && (!validId(change.target) || state.items.some(record => record.id === change.target) || state.balances.some(record => record.id === change.target))) throw Error('新增物品或资源编号无效或已存在。');
        if (!creating && !existing) throw Error('物品或资源已不存在于当前剧情分支。');
        if (data.newId !== undefined && (!validId(data.newId) || state.items.some(record => record.id === data.newId) || state.balances.some(record => record.id === data.newId))) throw Error('转交目标记录编号无效或已存在。');
        if (change.action === 'transfer-item' && existing.wear?.slot && data.newId !== undefined) throw Error('逐件衣物转交保留原编号，无需提供 newId。');
        if (change.action === 'set-condition' && !object(data.condition)) throw Error('请提供物品状态字段。');
        const op = creating ? change.action.replace('create-', 'save-') : change.action;
        const input = { ...(['save-item', 'save-balance'].includes(op) ? existing : {}), ...data, ...(creating ? { newId: change.target } : { id: change.target }), reason: change.reason };
        if (creating) { input.equipped ??= false; input.notes ??= ''; if (!isItem) input.unit ??= ''; }
        const result = applyInventory(readStore(ctx), ctx.chat, op, input, {
            ownerIds: readCharacters(ctx).characters.map(person => person.id), id: operationId, at: now,
            createId: () => { throw Error('新增转交记录需要显式 newId。'); },
        });
        return { patches: [{ path: [KEY], value: result.store }], summary: result.summary };
    },
};
