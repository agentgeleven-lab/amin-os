import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, emptyStore, appendSnapshot, buildRestore, readCharacters, getCharacter, resolveStat, bindings, withStatValue, validateState } from '../apps/characters/model.js';
import { createCharactersService } from '../apps/characters/service.js';

const chat = () => [{ name: '玩家', is_user: true, mes: '进入房间', swipe_id: 0 }];
const stat = (id = 'stealth', binding = '主角.潜行', component = 'value') => ({ id, label: id, binding, component, check: 'd20' });
const character = () => ({ id: 'hero', name: '调查员', kind: 'pc', notes: '', stats: [stat(), stat('hp', '主角.生命', 'current'), stat('hpMax', '主角.生命', 'max')] });
const state = () => ({ version: 1, characters: [character()] });
function fixture() {
    let saves = 0, sequence = 0;
    const ctx = { characterId: 0, characters: [{ avatar: 'hero.png' }], chatId: 'chat-1', getCurrentChatId() { return this.chatId; }, chat: chat(), chatMetadata: { variables: { unrelated: '保留', 状态栏: JSON.stringify({ 版本: 1, 项目: { 主角: { 潜行: 4, 生命: { 当前: 8, 最大: 12 }, 身份: '调查员' }, 同伴: { 潜行: 2 } } }) }, other: { keep: true } }, async saveMetadata() { saves++; } };
    ctx.chatMetadata[KEY] = appendSnapshot(emptyStore(), ctx.chat, state(), { id: 'initial', at: '2026-09-23T00:00:00Z' });
    const service = createCharactersService(() => ctx, { createId: () => `generated-${++sequence}`, now: () => '2026-09-23T01:00:00Z' });
    return { ctx, service, saves: () => saves };
}
test('character stats resolve the canonical nested World Status and never cache numeric values', () => {
    const h = fixture();
    assert.equal(resolveStat(h.ctx, 'hero', 'stealth').value, 4);
    const status = JSON.parse(h.ctx.chatMetadata.variables.状态栏); status.项目.主角.潜行 = 7;
    h.ctx.chatMetadata.variables.状态栏 = JSON.stringify(status);
    assert.equal(h.service.resolveStat('hero', 'stealth').value, 7);
    assert.equal(resolveStat(h.ctx, 'hero', 'hp').value, 8);
    assert.equal(resolveStat(h.ctx, 'hero', 'hpMax').value, 12);
    assert.equal(Object.hasOwn(readCharacters(h.ctx).characters[0].stats[0], 'value'), false);
    assert.deepEqual(bindings(h.ctx).map(item => [item.binding, item.component]), [['主角.潜行', 'value'], ['主角.生命', 'current'], ['主角.生命', 'max'], ['同伴.潜行', 'value']]);
    h.service.dispose();
});
test('missing or nonnumeric fields refuse a roll instead of guessing values', () => {
    const h = fixture(), before = structuredClone(h.ctx.chatMetadata);
    delete h.ctx.chatMetadata.variables.状态栏;
    assert.throws(() => resolveStat(h.ctx, 'hero', 'stealth'), /尚未建立/);
    h.ctx.chatMetadata.variables.状态栏 = before.variables.状态栏;
    const raw = JSON.parse(h.ctx.chatMetadata.variables.状态栏); delete raw.项目.主角.潜行;
    h.ctx.chatMetadata.variables.状态栏 = JSON.stringify(raw);
    assert.throws(() => resolveStat(h.ctx, 'hero', 'stealth'), /不存在/);
    raw.项目.主角.潜行 = '75 - 熟练'; h.ctx.chatMetadata.variables.状态栏 = JSON.stringify(raw);
    assert.throws(() => resolveStat(h.ctx, 'hero', 'stealth'), /类型不匹配/);
    assert.equal(getCharacter(h.ctx, 'unknown'), null);
    assert.throws(() => resolveStat(h.ctx, 'unknown', 'stealth'), /人物已不存在/);
    h.service.dispose();
});
test('stat writes preview then update only the canonical field; progress validates both components', async () => {
    const h = fixture(), originalCharacters = structuredClone(h.ctx.chatMetadata[KEY]);
    const preview = h.service.stageStatValue('hero', 'hp', 10);
    assert.match(preview.summary, /8 → 10/);
    assert.equal(resolveStat(h.ctx, 'hero', 'hp').value, 8);
    await h.service.confirm();
    assert.equal(resolveStat(h.ctx, 'hero', 'hp').value, 10);
    assert.equal(h.saves(), 1);
    assert.equal(h.ctx.chatMetadata.variables.unrelated, '保留');
    assert.deepEqual(h.ctx.chatMetadata.other, { keep: true });
    assert.deepEqual(h.ctx.chatMetadata[KEY], originalCharacters);
    for (const value of [-1, 13, NaN, Infinity, '4']) assert.throws(() => withStatValue(h.ctx, 'hero', 'hp', value));
    assert.throws(() => withStatValue(h.ctx, 'hero', 'hpMax', 9), /进度/);
    assert.throws(() => withStatValue(h.ctx, 'hero', 'hpMax', 0), /进度/);
    await h.service.setStatValue('hero', 'hpMax', 20);
    assert.equal(resolveStat(h.ctx, 'hero', 'hpMax').value, 20);
    h.service.dispose();
});
test('pending writes reject changed binding values and changed message candidates', async () => {
    const h = fixture();
    h.service.stageStatValue('hero', 'stealth', 10);
    const raw = JSON.parse(h.ctx.chatMetadata.variables.状态栏); raw.项目.主角.潜行 = 5;
    h.ctx.chatMetadata.variables.状态栏 = JSON.stringify(raw);
    await assert.rejects(h.service.confirm());
    assert.equal(resolveStat(h.ctx, 'hero', 'stealth').value, 5);
    h.service.stageStatValue('hero', 'stealth', 11);
    h.ctx.chat[0].swipe_id = 1;
    await assert.rejects(h.service.confirm());
    assert.equal(h.saves(), 0);
    h.service.dispose();
});
test('stable registry IDs survive editing and branch materialization excludes different candidates', async () => {
    const h = fixture();
    h.ctx.chat.push({ name: 'KP', is_user: false, mes: '发现同伴', swipe_id: 0 });
    await h.service.saveCharacter({ name: '同伴', kind: 'npc', notes: '向导', stats: [] });
    const added = h.service.read().characters.find(person => person.id !== 'hero');
    assert.ok(added.id);
    await h.service.saveCharacter({ ...added, name: '同行者' });
    assert.equal(h.service.read().characters.length, 2);
    assert.equal(getCharacter(h.ctx, added.id).name, '同行者');
    h.ctx.chat[1].swipe_id = 1;
    assert.deepEqual(h.service.read().characters.map(person => person.id), ['hero']);
    h.ctx.chat[1].swipe_id = 0;
    assert.equal(h.service.read().characters.length, 2);
    h.service.dispose();
});
test('restore adds materialized characters at the current branch and retains earlier events', () => {
    const h = fixture(), snapshot = state(); snapshot.characters[0].name = '存档名字';
    h.ctx.chat.push({ name: 'KP', is_user: false, mes: '另一条路线', swipe_id: 1 });
    const restored = buildRestore(h.ctx, snapshot, { id: 'restore-1', at: 'now' });
    assert.equal(restored.events.length, 2);
    assert.equal(restored.events.at(-1).path.length, 2);
    h.ctx.chatMetadata[KEY] = restored;
    assert.equal(getCharacter(h.ctx, 'hero').name, '存档名字');
    h.ctx.chat.pop();
    assert.equal(getCharacter(h.ctx, 'hero').name, '调查员');
    h.service.dispose();
});
test('save failure retains one confirmed operation and retry does not duplicate characters', async () => {
    const h = fixture(); let attempts = 0;
    h.ctx.saveMetadata = async () => { if (++attempts === 1) throw Error('offline'); };
    await assert.rejects(h.service.saveCharacter({ name: '新 NPC', kind: 'npc', notes: '', stats: [] }));
    const count = h.ctx.chatMetadata[KEY].events.length;
    assert.equal(h.service.dirty(), true);
    await h.service.retrySave();
    assert.equal(h.ctx.chatMetadata[KEY].events.length, count);
    assert.equal(h.service.read().characters.length, 2);
    assert.equal(h.service.dirty(), false);
    h.service.dispose();
});
test('malformed or future character stores are preserved and reject writes', async () => {
    const h = fixture();
    for (const corrupt of [{ version: 2, events: [], future: true }, { version: 1, events: [{ id: 'bad', at: 'now', path: [], snapshot: { version: 9, characters: [] } }] }]) {
        h.ctx.chatMetadata[KEY] = corrupt;
        const before = structuredClone(h.ctx.chatMetadata);
        await assert.rejects(h.service.saveCharacter({ name: 'N', kind: 'npc', notes: '', stats: [] }));
        assert.deepEqual(h.ctx.chatMetadata, before);
    }
    assert.throws(() => validateState({ version: 1, characters: [{ ...character(), stats: [{ ...stat(), value: 5 }] }] }), /不能另存数值/);
    assert.throws(() => validateState({ version: 1, characters: [{ ...character(), stats: [{ ...stat(), binding: '__proto__.x' }] }] }), /绑定/);
    h.service.dispose();
});
test('deleting a registry entry preserves world fields and cross-application references', async () => {
    const h = fixture(), worldBefore = h.ctx.chatMetadata.variables.状态栏;
    h.ctx.chatMetadata.amin_os_inventory_v1 = { ownerId: 'hero' };
    h.ctx.chatMetadata.amin_os_relationships_v1 = { fromId: 'hero' };
    await h.service.deleteCharacter('hero');
    assert.equal(h.service.read().characters.length, 0);
    assert.equal(h.ctx.chatMetadata.variables.状态栏, worldBefore);
    assert.equal(h.ctx.chatMetadata.amin_os_inventory_v1.ownerId, 'hero');
    assert.equal(h.ctx.chatMetadata.amin_os_relationships_v1.fromId, 'hero');
    h.service.dispose();
});
test('editing known character fields preserves compatible extension data', async () => {
    const h = fixture(), source = h.ctx.chatMetadata[KEY];
    source.extension = { keep: 'store' };
    source.events[0].snapshot.characters[0].extension = { keep: 'character' };
    source.events[0].snapshot.characters[0].stats[0].extension = { keep: 'stat' };
    await h.service.saveCharacter({ id: 'hero', name: '改名', kind: 'pc', notes: '', stats: character().stats });
    assert.equal(h.ctx.chatMetadata[KEY].extension.keep, 'store');
    assert.equal(h.service.read().characters[0].extension.keep, 'character');
    assert.equal(h.service.read().characters[0].stats[0].extension.keep, 'stat');
    h.service.dispose();
});
