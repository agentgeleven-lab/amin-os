import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LINKAGE_OWNER_FIELD, LINKAGE_ENTRY_MARKER, LINKAGE_PLACEHOLDER, LINKAGE_ENTRY_TITLE,
    prepareUnifiedWorldbook, installUnifiedWorldbook, inspectUnifiedWorldbook, unifiedWorldbookTarget,
} from '../apps/linkage/lorebook.js';
import { createLinkageHost, withLinkageToolScope } from '../apps/linkage/host.js';

const clone = value => structuredClone(value);
const owned = (patch = {}) => ({ uid: 1, world: 'book', content: LINKAGE_PLACEHOLDER, [LINKAGE_OWNER_FIELD]: LINKAGE_ENTRY_MARKER, ...patch });
const create = (name, book) => { const uid = Math.max(-1, ...Object.keys(book.entries).map(Number)) + 1; return book.entries[uid] = { uid }; };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const eventNames = ['GENERATION_AFTER_COMMANDS', 'WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'WORLDINFO_UPDATED'];

function context() {
    return { characterId: 0, groupId: null, characters: [{ avatar: 'hero.png', data: { extensions: { world: 'book' } } }],
        chatId: 'one', getCurrentChatId() { return this.chatId; }, chatMetadata: { state: 'private-one' },
        chat: [{ is_user: true, name: 'user', mes: 'before' }], getRequestHeaders: () => ({}) };
}
function hostFixture({ missingEvent, builder, capture, readSettings } = {}) {
    let ctx = context();
    const callbacks = new Map(), captured = [], replies = [], logs = [], builds = [];
    const settings = { enabled: true, modules: ['status', 'map', 'organizations'] };
    const source = {
        on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); },
        removeListener(name, fn) { callbacks.set(name, (callbacks.get(name) ?? []).filter(item => item !== fn)); },
        async emit(name, ...args) { for (const fn of [...(callbacks.get(name) ?? [])]) await fn(...args); },
    };
    const events = Object.fromEntries(eventNames.filter(name => name !== missingEvent).map(name => [name, name]));
    ctx.eventSource = source; ctx.eventTypes = events;
    const getContext = () => ctx;
    const host = createLinkageHost(getContext, {
        readSettings: readSettings ?? (() => settings),
        manages: (_ctx, module) => settings.enabled && settings.modules.includes(module),
        buildPrompt: builder ?? ((live, options) => { builds.push(options); return `${options.purpose}:${options.write}:${live.chatMetadata.state}`; }),
        captureGeneration: async type => { captured.push({ type, length: ctx.chat.length }); return await capture?.(type); },
        collectReply: async index => { replies.push(index); }, report: value => logs.push(value),
    });
    return {
        host, captured, replies, logs, builds, settings, callbacks, source, getContext,
        ctx: () => ctx,
        async start(type = 'normal', options = {}, dryRun = false) { await source.emit('GENERATION_AFTER_COMMANDS', type, options, dryRun); },
        async load(payload = { characterLore: [owned()] }) { await source.emit('WORLDINFO_ENTRIES_LOADED', payload); return payload; },
        async activate(payload) {
            // The real host deep-clones scan entries before activation.
            await source.emit('WORLD_INFO_ACTIVATED', clone(Object.values(payload).flat().filter(entry => !entry.disable)));
        },
        reply(text = 'story <amin_update>{"version":1,"changes":[]}</amin_update>') { ctx.chat.push({ is_user: false, mes: text, gen_finished: new Date().toISOString(), swipe_id: 0 }); return ctx.chat.length - 1; },
        async finish(index = ctx.chat.length - 1, reverse = false) {
            if (reverse) await source.emit('GENERATION_ENDED');
            await source.emit('MESSAGE_RECEIVED', index, 'normal');
            if (!reverse) await source.emit('GENERATION_ENDED');
            await pause();
        },
        async switchChat() { ctx = { ...ctx, chatId: 'two', chatMetadata: { state: 'private-two' }, chat: [] }; await source.emit('CHAT_CHANGED'); },
    };
}

test('unified template preserves unrelated entries and never serializes current-chat state', () => {
    const original = { name: 'book', entries: { 0: { uid: 0, comment: LINKAGE_ENTRY_TITLE, content: 'user-owned same title' } } };
    const prepared = prepareUnifiedWorldbook(original, 'book', create);
    assert.equal(prepared.entry.content, LINKAGE_PLACEHOLDER);
    assert.equal(prepared.entry[LINKAGE_OWNER_FIELD], LINKAGE_ENTRY_MARKER);
    assert.deepEqual(prepared.book.entries[0], original.entries[0]);
    assert.equal(Object.keys(original.entries).length, 1);
    assert.equal(prepared.entry.constant, true);
});

test('reinstall preserves user rules, placement, triggers and manual disable', () => {
    const entry = owned({ content: `my rules\n${LINKAGE_PLACEHOLDER}\nmore rules`, disable: true, position: 4, depth: 3, triggers: ['normal'] });
    const original = { entries: { 1: entry } };
    const prepared = prepareUnifiedWorldbook(original, 'book', create);
    assert.equal(prepared.changed, false);
    assert.deepEqual(prepared.book, original);
    assert.notEqual(prepared.book, original);
    for (const content of ['deleted placeholder', LINKAGE_PLACEHOLDER + LINKAGE_PLACEHOLDER]) {
        assert.throws(() => prepareUnifiedWorldbook({ entries: { 1: owned({ content }) } }, 'book', create), /占位/);
    }
    assert.throws(() => prepareUnifiedWorldbook({ entries: { 1: owned(), 2: owned({ uid: 2 }) } }, 'book', create), /多个/);
});

test('installer prefers the chat book, writes only an inert template and supports group chat books', async () => {
    const ctx = context(); ctx.groupId = 'party'; ctx.chatMetadata.world_info = 'chat-book';
    let persisted = { entries: { 0: { uid: 0, content: 'protected' } } };
    const bodies = [], cache = new Map();
    const result = await installUnifiedWorldbook({ getContext: () => ctx,
        loadModule: async () => ({ createWorldInfoEntry: create, worldInfoCache: cache }),
        fetcher: async (url, options) => { const body = JSON.parse(options.body); bodies.push([url, body]); if (url.endsWith('/edit')) persisted = body.data; return { ok: true, json: async () => clone(persisted) }; },
    });
    assert.equal(result.name, 'chat-book');
    assert.equal(result.action, '已新增');
    assert.ok(bodies.every(([, body]) => body.name === 'chat-book'));
    assert.equal(persisted.entries[1].content, LINKAGE_PLACEHOLDER);
    assert.equal(persisted.entries[0].content, 'protected');
    assert.equal(JSON.stringify(cache.get('chat-book')).includes('private-one'), false);
    delete ctx.chatMetadata.world_info;
    assert.throws(() => unifiedWorldbookTarget(ctx), /绑定/);
});

test('worldbook cache and concurrent server changes stop the installer before writing', async () => {
    for (const scenario of ['cache', 'server']) {
        const ctx = context(); let reads = 0, edits = 0;
        await assert.rejects(installUnifiedWorldbook({ getContext: () => ctx,
            loadModule: async () => ({ createWorldInfoEntry: create, worldInfoCache: new Map(scenario === 'cache' ? [['book', { entries: { 5: { uid: 5, content: 'unsaved' } } }]] : []) }),
            fetcher: async url => { if (url.endsWith('/edit')) edits++; reads++; return { ok: true, json: async () => scenario === 'server' && reads > 1 ? { entries: { 5: { uid: 5, content: 'concurrent' } } } : { entries: {} } }; },
        }), /未同步|其他操作/);
        assert.equal(edits, 0);
    }
});

test('switching chats during worldbook loading prevents installation; inspection remains read-only', async () => {
    const ctx = context(); let requests = 0;
    await assert.rejects(installUnifiedWorldbook({ getContext: () => ctx,
        loadModule: async () => { ctx.chatId = 'changed'; return { createWorldInfoEntry: create }; },
        fetcher: async () => { requests++; },
    }), /变化/);
    assert.equal(requests, 0);
    const result = await inspectUnifiedWorldbook({ getContext: () => ctx,
        fetcher: async url => { assert.match(url, /\/get$/); return { ok: true, json: async () => ({ entries: { 1: owned({ disable: true }) } }) }; },
    });
    assert.equal(result.exists, true); assert.equal(result.valid, true); assert.equal(result.enabled, false);
    assert.equal(result.content, LINKAGE_PLACEHOLDER);
});

test('runtime expands a single scan-local entry and suppresses only managed Amin-owned legacy rules', async () => {
    const f = hostFixture();
    const cached = Object.freeze(owned({ content: `before\n${LINKAGE_PLACEHOLDER}\nafter` }));
    const status = Object.freeze({ uid: 3, content: 'legacy status', world_status_hud_owner: 'world-status-hud/variable-update-v1' });
    const unowned = Object.freeze({ uid: 4, content: 'manual state rule' });
    try {
        await f.start();
        const payload = await f.load({ chatLore: [cached], globalLore: [cached, status, unowned] });
        assert.match(payload.chatLore[0].content, /^before\nstory:true:private-one\nafter$/);
        assert.equal(payload.globalLore[0].disable, true);
        assert.equal(payload.globalLore[1].disable, true);
        assert.equal(payload.globalLore[2], unowned);
        assert.equal(cached.content, `before\n${LINKAGE_PLACEHOLDER}\nafter`);
        assert.equal(status.content, 'legacy status');
        assert.equal(f.captured.length, 0);
        f.ctx().chat.push({ is_user: true, mes: 'new input' });
        await f.activate(payload);
        assert.deepEqual(f.captured, [{ type: 'normal', length: 2 }]);
        await f.activate(payload);
        const index = f.reply(); await f.finish(index);
        await f.source.emit('MESSAGE_RECEIVED', index, 'normal');
        await f.source.emit('GENERATION_ENDED'); await pause();
        assert.deepEqual(f.replies, [2]); assert.equal(f.captured.length, 1);
    } finally { f.host.destroy(); }
});

test('no activation, user-disabled entry, mismatched trigger or unsupported lifecycle cannot collect replies', async () => {
    for (const scenario of ['not-activated', 'disabled', 'trigger', 'unsupported']) {
        const f = hostFixture(scenario === 'unsupported' ? { missingEvent: 'WORLD_INFO_ACTIVATED' } : {});
        try {
            await f.start();
            const payload = await f.load({ characterLore: [owned({ disable: scenario === 'disabled', triggers: scenario === 'trigger' ? ['quiet'] : [] })] });
            if (scenario !== 'not-activated') await f.activate(payload);
            f.reply(); await f.finish();
            assert.deepEqual(f.replies, []); assert.deepEqual(f.captured, []);
            if (scenario !== 'not-activated') assert.equal(payload.characterLore[0].disable, true);
        } finally { f.host.destroy(); }
    }
});

test('master disabled preserves old rule entries and disables the unified template', async () => {
    const f = hostFixture(); f.settings.enabled = false;
    const legacy = { uid: 2, content: 'old', world_status_hud_owner: 'world-status-hud/variable-update-v1' };
    try {
        await f.start(); const payload = await f.load({ characterLore: [owned(), legacy] });
        assert.equal(payload.characterLore[0].disable, true);
        assert.equal(payload.characterLore[1], legacy);
        assert.equal(f.builds.length, 0);
    } finally { f.host.destroy(); }
});

test('streaming waits for completion and handles reversed host events without duplicate collection', async () => {
    for (const reverse of [false, true]) {
        const f = hostFixture();
        try {
            await f.start(); await f.activate(await f.load()); const index = f.reply();
            await f.source.emit('MESSAGE_RECEIVED', index, 'normal'); await pause();
            assert.deepEqual(f.replies, []);
            await f.finish(index, reverse);
            assert.deepEqual(f.replies, [index]);
        } finally { f.host.destroy(); }
    }
});

test('stopping after ended in the same turn, an aborted stream and chat switches discard candidates', async () => {
    for (const scenario of ['stopped', 'stream', 'chat', 'signal']) {
        const f = hostFixture(), controller = new AbortController();
        try {
            await f.start('normal', { signal: controller.signal }); await f.activate(await f.load()); const index = f.reply();
            if (scenario === 'stream') f.ctx().streamingProcessor = { isStopped: true };
            await f.source.emit('MESSAGE_RECEIVED', index, 'normal');
            await f.source.emit('GENERATION_ENDED');
            if (scenario === 'stopped') await f.source.emit('GENERATION_STOPPED');
            if (scenario === 'chat') await f.switchChat();
            if (scenario === 'signal') controller.abort();
            await pause(); assert.deepEqual(f.replies, []);
        } finally { f.host.destroy(); }
    }
});

test('quiet and continuation are read-only, and Amin quiet scope avoids duplicate worldbook content', async () => {
    const f = hostFixture();
    try {
        for (const type of ['quiet', 'continue', 'impersonate']) {
            await f.start(type); const payload = await f.load();
            assert.equal(payload.characterLore[0].content, `${type === 'quiet' ? 'tool' : 'story'}:false:private-one`);
            await f.activate(payload); f.reply(); await f.finish();
        }
        assert.deepEqual(f.captured, []); assert.deepEqual(f.replies, []);
        await withLinkageToolScope(f.getContext, async () => {
            await f.start('quiet'); const payload = await f.load(); assert.equal(payload.characterLore[0].disable, true);
            // A scope waiting on a quiet queue must never silence ordinary story.
            await f.start('normal'); assert.equal((await f.load()).characterLore[0].disable, undefined);
        });
        await f.start('quiet'); assert.equal((await f.load()).characterLore[0].disable, undefined);
    } finally { f.host.destroy(); }
});

test('tool scopes clean up on rejection and do not follow the user to another chat', async () => {
    const f = hostFixture();
    try {
        await assert.rejects(withLinkageToolScope(f.getContext, async () => { throw Error('tool failed'); }), /tool failed/);
        await f.start('quiet'); assert.equal((await f.load()).characterLore[0].disable, undefined);
        await withLinkageToolScope(f.getContext, async () => {
            await f.switchChat(); await f.start('quiet');
            assert.match((await f.load()).characterLore[0].content, /private-two/);
        });
    } finally { f.host.destroy(); }
});

test('changes between expansion and activation invalidate the update baseline', async () => {
    const f = hostFixture();
    try {
        await f.start(); const payload = await f.load(); f.ctx().chatMetadata.state = 'changed';
        await f.activate(payload); f.reply(); await f.finish();
        assert.deepEqual(f.captured, []); assert.deepEqual(f.replies, []);
        assert.ok(f.logs.some(value => value.includes('资料或设置已变化')));
    } finally { f.host.destroy(); }
});

test('dry-run inspection cannot cancel a captured live generation, and unchanged old replies are ignored', async () => {
    const f = hostFixture();
    try {
        f.reply('old answer');
        await f.start(); await f.activate(await f.load());
        await f.start('normal', {}, true); await f.finish();
        assert.deepEqual(f.replies, []);
        await f.start('swipe'); await f.activate(await f.load());
        const reply = f.ctx().chat.at(-1); reply.mes = 'new swipe'; reply.swipe_id = 1;
        await f.finish(); assert.deepEqual(f.replies, [1]);
    } finally { f.host.destroy(); }
});

test('malformed expansion fails closed and destroying the adapter removes all subscriptions', async () => {
    const f = hostFixture({ builder: () => { throw Error('invalid module state'); } });
    await f.start(); const payload = await f.load();
    assert.equal(payload.characterLore[0].disable, true);
    assert.equal(payload.characterLore[0].content, '');
    f.host.destroy();
    assert.ok([...f.callbacks.values()].every(list => list.length === 0));
});

test('regenerate and swipe prompt reads exclude the previous assistant candidate without editing the chat', async () => {
    const f = hostFixture({ builder: live => live.chat.map(message => message.mes).join('|') });
    try {
        f.reply('future from old candidate');
        for (const type of ['regenerate', 'swipe']) {
            await f.start(type); const payload = await f.load();
            assert.equal(payload.characterLore[0].content, 'before');
            assert.equal(f.ctx().chat.length, 2);
            assert.equal(f.ctx().chat.at(-1).mes, 'future from old candidate');
            await f.activate(payload);
        }
    } finally { f.host.destroy(); }
});

test('malformed chat policy and a busy service do not interrupt host generation or collect replies', async () => {
    const broken = hostFixture({ readSettings: () => { throw Error('invalid settings'); } });
    try {
        await broken.start();
        assert.equal((await broken.load()).characterLore[0].disable, true);
        assert.equal(broken.host.status().captured, false);
    } finally { broken.host.destroy(); }
    const busy = hostFixture({ capture: () => false });
    try {
        await busy.start(); await busy.activate(await busy.load());
        busy.reply(); await busy.finish();
        assert.equal(busy.host.status().captured, false);
        assert.deepEqual(busy.replies, []);
    } finally { busy.host.destroy(); }
});
