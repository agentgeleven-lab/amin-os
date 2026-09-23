import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGenerationSources } from '../apps/generation/sources.js';

function fixture() {
    const calls = [];
    const ctx = { characterId: 0, characters: [{ avatar: 'hero.png', name: 'Hero', data: { description: 'CARD', extensions: { world: 'bound' } } }], chatMetadata: { world_info: 'chatbook' }, chat: [{ name: 'You', is_user: true, mes: 'FIRST' }, { name: 'Hero', mes: 'SECOND', swipe_id: 1 }], name1: 'Player', powerUserSettings: { persona_description: 'PERSONA' }, getCurrentChatId: () => 'chat' };
    const options = { loadWorldInfo: async () => ({ selected_world_info: ['global'], world_info: {} }), readBook: async name => { calls.push(name); return { entries: { a: { comment: 'Visible', content: name + '-CONTENT', key: ['key'] }, b: { content: 'HIDDEN', disable: true }, c: { content: 'DISABLED', enabled: false } } }; } };
    return { ctx, options, calls };
}

test('selected books only, card and persona are independent, disabled entries never included', async () => {
    const { ctx, options, calls } = fixture();
    const result = await collectGenerationSources(ctx, { includeCharacter: true, includePersona: true, readWorldbooks: true, selectedBooks: ['chatbook'] }, options);
    assert.deepEqual(calls, ['chatbook']);
    const data = JSON.parse(result.text);
    assert.equal(data.characters[0].description, 'CARD');
    assert.equal(data.persona.描述, 'PERSONA');
    assert.equal(data.worldbooks[0].entries.length, 1);
    assert.deepEqual(data.worldbooks[0].entries[0].keys, ['key']);
    assert.equal(result.provenance.chat, null);
    assert.ok(!result.text.includes('HIDDEN'));
    assert.ok(!result.text.includes('global-CONTENT'));
});

test('null/empty selection and disabled worldbooks never call host APIs or auto-read bound books', async () => {
    const { ctx } = fixture();
    const options = { loadWorldInfo: () => { throw Error('must not read'); } };
    for (const selectedBooks of [null, []]) {
        const value = await collectGenerationSources(ctx, { includeCharacter: true, readWorldbooks: true, selectedBooks }, options);
        assert.deepEqual(JSON.parse(value.text).worldbooks, []);
    }
    const value = await collectGenerationSources(ctx, { readWorldbooks: false, selectedBooks: ['global'] }, options);
    assert.deepEqual(JSON.parse(value.text), { worldbooks: [] });
});

test('empty chat supports initialization from card or worldbook without inventing a range', async () => {
    const { ctx, options } = fixture(); ctx.chat = [];
    const value = await collectGenerationSources(ctx, { includeCharacter: true, readWorldbooks: true, selectedBooks: ['bound'], includeChat: false }, options);
    assert.equal(value.provenance.chat, null);
    assert.equal(JSON.parse(value.text).worldbooks[0].name, 'bound');
    await assert.rejects(collectGenerationSources(ctx, { includeChat: true, start: 0, end: 0 }), /楼层/);
});

test('chat ranges are exact inclusive indexes, preserving full text and swipe provenance', async () => {
    const { ctx } = fixture(); ctx.chat[1].mes = '正文'.repeat(50000) + 'END';
    const value = await collectGenerationSources(ctx, { includeChat: true, start: 1, end: 1 });
    assert.deepEqual(value.provenance.chat, { start: 1, end: 1, indices: [1] });
    assert.deepEqual(JSON.parse(value.text).chat, [{ index: 1, floor: 2, name: 'Hero', isUser: false, isSystem: false, swipeId: 1, text: ctx.chat[1].mes }]);
    for (const [start, end] of [[-1, 0], [1, 0], [0, 2], [0.5, 1], [undefined, undefined]]) await assert.rejects(collectGenerationSources(ctx, { includeChat: true, start, end }), /楼层/);
    ctx.chat[0] = null;
    await assert.rejects(collectGenerationSources(ctx, { includeChat: true, start: 0, end: 1 }), /未截断/);
});

test('missing requested material or host APIs fail clearly instead of broadening sources', async () => {
    const { ctx, options } = fixture();
    await assert.rejects(collectGenerationSources(ctx, { readWorldbooks: true, selectedBooks: ['inactive'] }, options), /未启用/);
    await assert.rejects(collectGenerationSources(ctx, { readWorldbooks: true, selectedBooks: ['global'] }, { loadWorldInfo: async () => ({}) }), /列表/);
    await assert.rejects(collectGenerationSources(ctx, { readWorldbooks: true, selectedBooks: ['global'] }, { loadWorldInfo: options.loadWorldInfo }), /请求接口/);
    ctx.characters = [];
    await assert.rejects(collectGenerationSources(ctx, { includeCharacter: true }), /角色卡/);
    ctx.powerUserSettings = {};
    await assert.rejects(collectGenerationSources(ctx, { includePersona: true }), /Persona/);
});

test('abort and edits during asynchronous reads invalidate collection', async () => {
    for (const mutate of [h => { h.ctx.chat[0].mes = 'EDIT'; }, h => { h.sources.includeChat = false; }, h => { h.ctx.characters[0].data.description = 'EDIT'; }, h => h.controller.abort(Error('CANCELLED'))]) {
        const h = fixture(); h.sources = { includeCharacter: true, includeChat: true, start: 0, end: 0, readWorldbooks: true, selectedBooks: ['global'] }; h.controller = new AbortController();
        const original = h.options.readBook;
        h.options.readBook = async name => { const book = await original(name); mutate(h); return book; };
        await assert.rejects(collectGenerationSources(h.ctx, h.sources, { ...h.options, signal: h.controller.signal }), /变化|CANCELLED/);
    }
    const { ctx } = fixture(); const controller = new AbortController(); controller.abort(Error('CANCELLED'));
    await assert.rejects(collectGenerationSources(ctx, {}, { signal: controller.signal }), /CANCELLED/);
});

test('selection order and duplicate names produce deterministic sources; guard called around awaits', async () => {
    const { ctx, options } = fixture(); let checks = 0;
    const first = await collectGenerationSources(ctx, { readWorldbooks: true, selectedBooks: ['global', 'bound', 'global'] }, { ...options, check: () => checks++ });
    const second = await collectGenerationSources(ctx, { readWorldbooks: true, selectedBooks: ['bound', 'global'] }, options);
    assert.deepEqual(first, second); assert.ok(checks >= 6);
});

test('group cards include members only and are not accompanied by their bound books', async () => {
    const { ctx } = fixture(); ctx.groupId = 'group'; ctx.groups = [{ id: 'group', members: ['hero.png'] }]; ctx.characters.push({ avatar: 'outsider.png', description: 'PRIVATE' });
    const result = await collectGenerationSources(ctx, { includeCharacter: true });
    assert.equal(JSON.parse(result.text).characters.length, 1); assert.ok(!result.text.includes('PRIVATE'));
});
