import { KEY, activeEffects, change, readStore, timedEffects } from '../../effects/model.js';
import { readCurrentScene } from '../../scene/model.js';
import { SETTLEMENT_PATHS, buildSettlement, metadataEffects, validatePeriodicReferences } from '../../effects/settlement.js';
import { mayRead } from '../policy.js';

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const dataKeys = {
    create: ['skillId', 'holder', 'target', 'targetMode', 'scope', 'command', 'condition', 'durationMinutes', 'stacking', 'periodic'],
    update: ['holder', 'command', 'condition', 'durationMinutes', 'stacking', 'periodic'],
    pause: ['paused'], end: [], settle: [],
};
export const adapter = {
    id: 'effects', label: '能力与持续效果', paths: SETTLEMENT_PATHS,
    contract: 'create: target=安全的新效果ID, data={skillId:已存在能力ID,holder,target?,targetMode:targeted|direct,scope,command?,condition,durationMinutes?:正整数|null,stacking?:{mode:independent|refresh|stack,key:安全状态类型ID,maxStacks:1..100,stacks:1..maxStacks},periodic?:{intervalMinutes:正整数,scaleWithStacks:boolean,operations:[{kind:stat,characterId,statId,delta:非零数}|{kind:item,itemId,quantity:正整数}|{kind:balance,balanceId,delta:非零数}]}}。update: target=当前效果ID,data={holder?,command?,condition?,durationMinutes?,stacking?,periodic?}。pause: target=当前效果ID,data={paused:boolean}。end: target=当前效果ID,data={}。settle: target=当前效果ID,data={}，只结算已到期未处理周期，同批原子更新绑定世界状态、背包及已结算剧情时刻。叠层/刷新前需先结算待处理周期。读取或推进时间不自动扣值，不修改全局能力库。',
    read(ctx) {
        const store = readStore(ctx), clock = readCurrentScene(ctx).clock;
        return { enabled: store.enabled, clock, skills: store.skills.map(skill => ({ id: skill.id, name: skill.name, reminder: skill.reminder })),
            effects: timedEffects(store, ctx?.chat, clock) };
    },
    readForPrompt(ctx) {
        const store = readStore(ctx), includeClock = mayRead(ctx, 'scene'), clock = includeClock ? readCurrentScene(ctx).clock : null;
        return { enabled: store.enabled, ...(includeClock ? { clock } : {}),
            skills: store.skills.map(skill => ({ id: skill.id, name: skill.name, reminder: skill.reminder })),
            effects: includeClock ? timedEffects(store, ctx?.chat, clock) : activeEffects(store, ctx?.chat) };
    },
    apply(ctx, input, { operationId, now } = {}) {
        if (input.module !== 'effects' || !dataKeys[input.action]) throw Error('持续效果不支持此联动操作。');
        if (typeof operationId !== 'string' || !/^[A-Za-z0-9:_-]{1,80}$/.test(operationId) || typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw Error('持续效果操作编号或记录时间无效。');
        const data = input.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !dataKeys[input.action].includes(key))) throw Error('持续效果联动参数含不支持的字段。');
        if (!safeId(input.target)) throw Error('持续效果编号无效。');
        if (typeof input.reason !== 'string' || !input.reason.trim()) throw Error('持续效果变更需要剧情依据。');
        if (input.action === 'settle') return buildSettlement(ctx, { effectIds: [input.target], operationId, now });
        const store = readStore(ctx), current = activeEffects(store, ctx?.chat).find(effect => effect.id === input.target);
        if (input.action === 'create' && current) throw Error('效果编号已存在。');
        if (input.action !== 'create' && !current) throw Error('效果不在当前剧情分支。');
        if (data.periodic) validatePeriodicReferences(ctx, data.periodic);
        const values = input.action === 'update' ? { holder: current.holder, command: current.command, condition: current.condition, ...data, id: input.target } : { ...data, id: input.target, reason: input.reason };
        const next = change(store, ctx?.chat, input.action, values, { clock: readCurrentScene(ctx).clock, createId: () => input.target, at: now });
        const event = next.events.at(-1); event.operationId = operationId; event.reason = input.reason;
        return { patches: [{ path: [KEY], value: metadataEffects(next, ctx) }], summary: `${{ create: '建立', update: '调整', pause: data.paused ? '暂停' : '恢复', end: '解除' }[input.action]}持续效果：${current?.skill.name ?? store.skills.find(skill => skill.id === data.skillId)?.name}` };
    },
};
