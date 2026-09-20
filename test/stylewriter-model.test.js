import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STORE_KEY, MODES, LIMITS, containsSecret, validatePresetDraft, normalizePreset, normalizeStore,
    createStore, chatIdentity, chatContentStamp, referenceSamples, fillGuard, presetStamp, buildRequest, normalizeResult,
} from '../apps/stylewriter/model.js';

const hostFixture = () => {
    const host = { extensionSettings: {}, saved: 0, saveSettingsDebounced() { this.saved++; } };
    return host;
};
const chatFixture = (over = {}) => ({
    getCurrentChatId: () => 'chat-a',
    characterId: 0,
    groupId: null,
    name1: '我',
    name2: '艾琳',
    characters: [{ avatar: 'a.png', name: '艾琳' }],
    chatMetadata: { note_title: '初见' },
    chat: [
        { name: '艾琳', is_user: false, mes: '风声掠过塔顶。' },
        { name: '我', is_user: true, mes: '我抬头看她。' },
        { name: '', is_user: false, is_system: true, mes: 'SYSTEM NOTE' },
        { name: '艾琳', is_user: false, mes: '她别过脸去。' },
    ],
    ...over,
});

test('style presets validate names and descriptions and never accept key-shaped text', () => {
    assert.throws(() => validatePresetDraft({ name: '', description: '说明' }), /名称/);
    assert.throws(() => validatePresetDraft({ name: '   ', description: '说明' }), /名称/);
    assert.throws(() => validatePresetDraft({ name: 'x'.repeat(41), description: '说明' }), /40/);
    assert.throws(() => validatePresetDraft({ name: '风格', description: '' }), /文风说明/);
    // no description length cap: very long style notes pass through verbatim
    assert.equal(validatePresetDraft({ name: '风格', description: '长'.repeat(5000) }).description.length, 5000);
    assert.throws(() => validatePresetDraft({ name: '风格', description: 'api_key=abcd1234efgh5678' }), /密钥/);
    assert.throws(() => validatePresetDraft({ name: '风格', description: 'key sk-ABCDEFGHIJKLMNOPQRST' }), /密钥/);
    assert.throws(() => validatePresetDraft({ name: 'sk-ABCDEFGHIJKLMNOPQRST', description: '说明' }), /密钥/);
    assert.ok(containsSecret('Bearer abcdefghijklmnopqrstuvwxyz'));
    assert.equal(containsSecret('这是一段普通的文风描述'), null);
    const existing = [{ id: 'a', name: '风格', description: 'x' }];
    assert.throws(() => validatePresetDraft({ name: '风格', description: 'y' }, existing), /同名/);
    assert.deepEqual(validatePresetDraft({ name: ' 风格 ', description: ' y ' }, existing, 'a'), { name: '风格', description: 'y' });
    assert.equal(normalizePreset({ id: '', name: 'x', description: 'y' }), null);
    // stored presets are never trimmed or truncated on load, even legacy over-cap values
    const legacy = normalizePreset({ id: 'legacy', name: 'n'.repeat(60), description: 'd'.repeat(9000) });
    assert.equal(legacy.name.length, 60);
    assert.equal(legacy.description.length, 9000);
    assert.equal(normalizePreset({ id: 'p', name: ' ', description: 'y' }), null);
    assert.equal(normalizePreset('junk'), null);
    const store = normalizeStore({ presets: [{ id: 'p', name: 'x', description: 'y' }, { id: 'p', name: 'dup', description: 'z' }, null, { id: 'q', name: 'ok', description: 'z' }], selectedId: 'q', mode: 'custom' });
    assert.deepEqual(store.presets.map(p => p.id), ['p', 'q']);
    assert.equal(store.selectedId, 'q');
    assert.equal(store.mode, 'custom');
    assert.equal(normalizeStore({ mode: 'bogus' }).mode, 'chat');
    assert.equal(normalizeStore(null).selectedId, '');
});

test('preset store seeds once, persists CRUD to extensionSettings and keeps only safe fields', () => {
    const host = hostFixture();
    const store = createStore(() => host);
    assert.equal(store.list().length, 2);
    assert.equal(store.mode(), 'chat');
    assert.ok(store.selectedId());
    const created = store.save({ name: '测试文风', description: '多用短句' });
    assert.ok(created.id && created.updatedAt);
    assert.deepEqual(Object.keys(created).sort(), ['description', 'id', 'name', 'updatedAt']);
    const saved = host.extensionSettings[STORE_KEY];
    assert.equal(saved.presets.length, 3);
    assert.equal(saved.selectedId, created.id);
    assert.deepEqual(Object.keys(saved).sort(), ['mode', 'presets', 'selectedId']);
    assert.ok(!JSON.stringify(saved).includes('apiKey'));
    assert.throws(() => store.save({ name: '测试文风', description: 'x' }), /同名/);
    const updated = store.save({ name: '测试文风2', description: '改' }, created.id);
    assert.equal(updated.id, created.id);
    assert.equal(store.list().filter(p => p.name === '测试文风2').length, 1);
    store.select(store.list()[0].id);
    assert.equal(store.selectedId(), store.list()[0].id);
    assert.throws(() => store.select('missing'), /不存在/);
    store.setMode('custom');
    assert.equal(store.mode(), 'custom');
    assert.throws(() => store.setMode('bogus'), /模式/);
    // reload does not reseed and keeps persisted values
    const reloaded = createStore(() => host, { seeds: [{ name: 'never', description: 'nope' }] });
    assert.equal(reloaded.list().length, 3);
    assert.equal(reloaded.mode(), 'custom');
    const token = store.remove(updated.id);
    assert.equal(token.preset.id, updated.id);
    assert.ok(!store.get(updated.id));
    assert.ok(store.selectedId() !== updated.id);
    store.restore(token);
    assert.equal(store.get(updated.id)?.name, '测试文风2');
    assert.throws(() => store.restore(token), /已存在/);
    assert.throws(() => store.remove('missing'), /不存在/);
    assert.ok(host.saved > 0);
});

test('chat identity and content stamps cover chat, character, group and metadata', () => {
    const base = chatFixture();
    const stamp = chatIdentity(base);
    assert.equal(chatIdentity(base), stamp, 'the same context object keeps its identity');
    assert.notEqual(chatIdentity(chatFixture({ getCurrentChatId: () => 'chat-b' })), stamp);
    assert.notEqual(chatIdentity(chatFixture({ characterId: 1 })), stamp);
    assert.notEqual(chatIdentity(chatFixture({ groupId: 7 })), stamp);
    assert.notEqual(chatIdentity(chatFixture({ name1: '别人' })), stamp);
    assert.notEqual(chatIdentity(chatFixture({ name2: '别人' })), stamp);
    assert.notEqual(chatIdentity(chatFixture({ characters: [{ avatar: 'b.png' }] })), stamp);
    // identity keys on the metadata object reference, never on editable fields inside it
    base.chatMetadata.note_title = '二周目';
    assert.equal(chatIdentity(base), stamp, 'editing note_title keeps the same chat identity');
    assert.notEqual(chatIdentity(chatFixture({ chatMetadata: { note_title: '初见' } })), stamp, 'a replaced metadata object is a new chat');
    const content = chatContentStamp(base);
    assert.equal(chatContentStamp(chatFixture()), content);
    assert.notEqual(chatContentStamp(chatFixture({ chat: [...base.chat, { name: '我', is_user: true, mes: '新消息' }] })), content);
    assert.notEqual(chatContentStamp(chatFixture({ chat: base.chat.map((m, i) => i === 3 ? { ...m, swipe_id: 2 } : m) })), content);
    // system-only additions do not disturb the prose stamp
    assert.equal(chatContentStamp(chatFixture({ chat: [...base.chat, { is_system: true, mes: 'HIDDEN' }] })), content);
    assert.equal(presetStamp({ id: 'p', name: 'a', description: 'x' }), presetStamp({ id: 'p', name: 'a', description: 'x' }));
    assert.notEqual(presetStamp({ id: 'p', name: 'a', description: 'x' }), presetStamp({ id: 'p', name: 'a', description: 'y' }));
});

test('reference samples use only recent non-system prose, kept whole, with an explicit window', () => {
    const base = chatFixture();
    const result = referenceSamples(base);
    assert.equal(result.total, 3);
    assert.equal(result.included, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.samples.map(s => s.role), ['character', 'user', 'character']);
    assert.equal(result.samples[0].speaker, '艾琳');
    assert.ok(!JSON.stringify(result.samples).includes('SYSTEM'));
    // the window is message-count based only: 20 messages → the latest 16, each kept whole
    const many = Array.from({ length: 20 }, (_, i) => ({ name: '艾琳', is_user: false, mes: `第${i}条消息。` }));
    const windowed = referenceSamples(chatFixture({ chat: many }));
    assert.equal(windowed.included, 16);
    assert.equal(windowed.total, 20);
    assert.equal(windowed.truncated, true);
    assert.deepEqual(windowed.samples.map(s => s.text), many.slice(4).map(m => m.mes));
    // no character budget: huge messages pass whole even when the total far exceeds 12000 chars
    const long = '长'.repeat(12000);
    const heavy = referenceSamples(chatFixture({ chat: [...base.chat.filter(m => !m.is_system), { name: '艾琳', mes: '开篇' + long }] }));
    assert.equal(heavy.included, 4);
    assert.equal(heavy.truncated, false);
    assert.equal(heavy.samples.at(-1).text.length, '开篇'.length + 12000);
    assert.ok(heavy.chars > 12000, 'the whole window is delivered regardless of total size');
    const single = referenceSamples(chatFixture({ chat: [{ name: '艾琳', mes: long }] }));
    assert.equal(single.included, 1);
    assert.equal(single.samples[0].text.length, 12000);
    assert.equal(referenceSamples(chatFixture({ chat: [] })).samples.length, 0);
    assert.equal(referenceSamples({}).samples.length, 0);
    assert.deepEqual(referenceSamples(base, { history: 1 }).samples.map(s => s.text), ['她别过脸去。']);
});

test('fill guard blocks changed chat, replaced input node and edited drafts', () => {
    const node = { tag: 'input' };
    const data = { node, expectedNode: node, value: 'a', expectedValue: 'a', identity: 'i', expectedIdentity: 'i' };
    assert.deepEqual(fillGuard(data), { ok: true });
    assert.equal(fillGuard({ ...data, identity: 'j' }).reason, 'chat');
    assert.equal(fillGuard({ ...data, node: {} }).reason, 'node');
    assert.equal(fillGuard({ ...data, expectedNode: null }).reason, 'node');
    assert.equal(fillGuard({ ...data, value: 'b' }).reason, 'draft');
    assert.match(fillGuard({ ...data, value: 'b' }).message, /不会覆盖新草稿/);
});

test('requests keep the source verbatim, separate both modes and refuse empty inputs', () => {
    const preset = { id: 'p1', name: '简洁明快', description: '短句为主，动词优先。' };
    const samples = referenceSamples(chatFixture());
    assert.throws(() => buildRequest({ mode: 'chat', source: '  ' }), /原文/);
    assert.throws(() => buildRequest({ mode: 'custom', source: 'x' }), /预设/);
    assert.throws(() => buildRequest({ mode: 'bogus', source: 'x' }), /模式/);
    assert.throws(() => buildRequest({ mode: 'chat', source: 'x', samples: referenceSamples(chatFixture({ chat: [] })) }), /自定义文风/);
    const custom = buildRequest({ mode: 'custom', source: '原文内容', preset });
    assert.match(custom.prompt, /简洁明快/);
    assert.match(custom.prompt, /短句为主，动词优先。/);
    assert.match(custom.prompt, /原文内容/);
    assert.ok(!custom.prompt.includes('艾琳'));
    assert.ok(!custom.prompt.includes('风声'));
    assert.equal(custom.meta.presetName, '简洁明快');
    assert.equal(custom.meta.mode, 'custom');
    const chat = buildRequest({ mode: 'chat', source: '原文内容', samples });
    assert.match(chat.prompt, /艾琳/);
    assert.match(chat.prompt, /风声掠过塔顶/);
    assert.match(chat.systemPrompt, /不补充原文没有的信息/);
    assert.match(chat.systemPrompt, /不代替原文之外的角色/);
    assert.equal(chat.meta.sampleCount, 3);
    assert.match(chat.meta.label, /样本 3 条/);
    assert.ok(!chat.prompt.includes(preset.description));
    const long = '源'.repeat(20000);
    const whole = buildRequest({ mode: 'chat', source: long, samples });
    assert.ok(whole.prompt.includes(long));
    assert.equal(whole.meta.sourceChars, 20000);
    const truncatedLabel = buildRequest({ mode: 'chat', source: 'x', samples: { ...samples, truncated: true } }).meta.label;
    assert.match(truncatedLabel, /更早消息未包含/);
    assert.equal(MODES.length, 2);
    assert.equal(normalizeResult('  <think>x</think> 改写后\n'), '改写后');
    assert.equal(normalizeResult('ok'), 'ok');
    assert.throws(() => normalizeResult('   '), /未返回/);
    // no length cap: a very long rewrite is accepted whole
    assert.equal(normalizeResult('x'.repeat(70000)).length, 70000);
});

test('store commit keeps in-memory state consistent when host saves fail', async () => {
    // synchronous failure: the list does not change, the error surfaces, the host value is restored
    const broken = {
        extensionSettings: { [STORE_KEY]: normalizeStore({ presets: [{ id: 'p1', name: '旧文风', description: '旧' }] }) },
        saveSettingsDebounced() { throw Error('save boom'); },
    };
    const store = createStore(() => broken);
    const before = JSON.stringify(store.list());
    assert.throws(() => store.save({ name: '新文风', description: 'x' }), /save boom/);
    assert.equal(JSON.stringify(store.list()), before);
    assert.equal(broken.extensionSettings[STORE_KEY].presets.length, 1);
    // no host settings at all
    const bare = createStore(() => null, { seeds: [] });
    assert.throws(() => bare.save({ name: 'x', description: 'y' }), /尚未就绪/);
    // asynchronous failure: host value and in-memory state roll back together, listeners hear it
    const asyncHost = { extensionSettings: {}, saved: 0, saveSettingsDebounced() { this.saved++; if(this.saved===1)return; return Promise.reject(new Error('disk broken')); } };
    const asyncStore = createStore(() => asyncHost);
    const events = [];
    asyncStore.subscribe(error => events.push(error?.message ?? null));
    asyncStore.save({ name: '异步文风', description: 'x' });
    assert.ok(asyncStore.list().some(p => p.name === '异步文风'));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!asyncStore.list().some(p => p.name === '异步文风'), 'in-memory list rolled back');
    assert.ok(!asyncHost.extensionSettings[STORE_KEY].presets.some(p => p.name === '异步文风'), 'host value rolled back');
    assert.ok(asyncStore.list().some(p => p.name === '简洁明快'), 'rollback lands on the last successful state');
    // the save notifies normally (null), the async failure notifies again with the error
    assert.deepEqual(events, [null, 'disk broken']);
});
test('chained async save failures restore the last valid state in any rejection order', async () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const rejectable = () => { let reject; const promise = new Promise((_, rej) => { reject = rej; }); return { promise, reject }; };
    // the first host call is the seed save (void → confirmed), later calls return gated promises
    const build = () => {
        const gates = [];
        let seeded = false;
        const host = {
            extensionSettings: {}, saved: 0,
            saveSettingsDebounced() { this.saved++; if (!seeded) { seeded = true; return undefined; } const gate = rejectable(); gates.push(gate); return gate.promise; },
        };
        return { host, gates };
    };

    // A fails first, then B: both land back on the seeded baseline, host matches memory
    {
        const { host, gates } = build();
        const store = createStore(() => host);
        const events = [];
        store.subscribe(error => { if (error) events.push(error.message); });
        store.save({ name: '甲', description: 'x' });
        store.save({ name: '乙', description: 'y' });
        gates[0].reject(new Error('A 失败'));
        await tick();
        assert.deepEqual(events, [], 'no rollback while a later save is still pending');
        assert.ok(store.list().some(p => p.name === '乙'), 'the surviving pending save still leads the state');
        gates[1].reject(new Error('B 失败'));
        await tick();
        assert.deepEqual(store.list().map(p => p.name), ['简洁明快', '细腻古典'], 'both failures roll back to the baseline');
        assert.deepEqual(host.extensionSettings[STORE_KEY].presets.map(p => p.name), ['简洁明快', '细腻古典'], 'host matches memory');
        assert.deepEqual(events, ['B 失败']);
    }

    // reversed rejection order: B first, then A — the same final state
    {
        const { host, gates } = build();
        const store = createStore(() => host);
        const events = [];
        store.subscribe(error => { if (error) events.push(error.message); });
        store.save({ name: '甲', description: 'x' });
        store.save({ name: '乙', description: 'y' });
        gates[1].reject(new Error('B 失败'));
        await tick();
        assert.deepEqual(store.list().map(p => p.name), ['简洁明快', '细腻古典', '甲'], 'first rolls back to the still-pending A');
        assert.deepEqual(host.extensionSettings[STORE_KEY].presets.map(p => p.name), ['简洁明快', '细腻古典', '甲']);
        gates[0].reject(new Error('A 失败'));
        await tick();
        assert.deepEqual(store.list().map(p => p.name), ['简洁明快', '细腻古典'], 'every rejection order reaches the same baseline');
        assert.deepEqual(host.extensionSettings[STORE_KEY].presets.map(p => p.name), ['简洁明快', '细腻古典']);
        assert.deepEqual(events, ['B 失败', 'A 失败']);
    }
});

test('a later successful save survives an earlier failure, in both orders', async () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const gate = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
    const build = () => {
        const gates = [];
        let seeded = false;
        const host = {
            extensionSettings: {}, saved: 0,
            saveSettingsDebounced() { this.saved++; if (!seeded) { seeded = true; return undefined; } const deferred = gate(); gates.push(deferred); return deferred.promise; },
        };
        return { host, gates };
    };

    // failure settles first, success arrives afterwards
    {
        const { host, gates } = build();
        const store = createStore(() => host);
        const events = [];
        store.subscribe(error => { if (error) events.push(error.message); });
        store.save({ name: '甲', description: 'x' });
        store.save({ name: '乙', description: 'y' });
        gates[0].reject(new Error('A 失败'));
        await tick();
        gates[1].resolve();
        await tick();
        assert.ok(store.list().some(p => p.name === '乙') && store.list().some(p => p.name === '甲'), 'the successful later save keeps everything');
        assert.equal(host.extensionSettings[STORE_KEY].presets.filter(p => p.name === '乙').length, 1);
        assert.deepEqual(events, [], 'no rollback ever happens');
    }

    // success confirms first, the earlier failure rejects afterwards
    {
        const { host, gates } = build();
        const store = createStore(() => host);
        const events = [];
        store.subscribe(error => { if (error) events.push(error.message); });
        store.save({ name: '甲', description: 'x' });
        store.save({ name: '乙', description: 'y' });
        gates[1].resolve();
        await tick();
        gates[0].reject(new Error('A 失败'));
        await tick();
        assert.ok(store.list().some(p => p.name === '乙'), 'an early failure cannot roll back a confirmed save');
        assert.equal(host.extensionSettings[STORE_KEY].presets.filter(p => p.name === '乙').length, 1);
        assert.deepEqual(events, []);
    }
});
test('late older success cannot replace the latest confirmed rollback checkpoint',async()=>{
 const gates=[];let saves=0;const host={extensionSettings:{},saveSettingsDebounced(){if(++saves===1)return;let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});gates.push({resolve,reject});return promise;}};
 const store=createStore(()=>host),tick=()=>new Promise(resolve=>setImmediate(resolve));
 store.save({name:'先保存',description:'甲'});store.save({name:'后保存',description:'乙'});
 gates[1].resolve();await tick();gates[0].resolve();await tick();
 store.save({name:'失败的保存',description:'丙'});gates[2].reject(Error('未落盘'));await tick();
 assert.ok(store.list().some(p=>p.name==='后保存'));assert.ok(!store.list().some(p=>p.name==='失败的保存'));assert.deepEqual(host.extensionSettings[STORE_KEY].presets,store.list());
});
