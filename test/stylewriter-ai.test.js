import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI as realCreateAI, AI_APPS, getAI } from '../ai/service.js';
import { rewriteText, APP_TASK, writeToInput } from '../apps/stylewriter/generator.js';
import { buildRequest, referenceSamples } from '../apps/stylewriter/model.js';
import { KEY, empty, change } from '../apps/effects/model.js';

const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map }; };
const bodies = [];
let currentCtx = null;
const transport = {
    // One in-flight job at a time in these tests: remember the ctx and keep the captured model
    // so channel pinning stays observable in the request body.
    resolveConnection: async (config, ctx) => { currentCtx = ctx; return { ...config, enabled: true, baseUrl: 'https://mock.test/v1' }; },
    fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        bodies.push({ url, body });
        const content = await currentCtx.mockGenerate({ responseLength: body.max_tokens, systemPrompt: body.messages[0].content, prompt: body.messages.slice(1).map(m => m.content).join('\n') });
        return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
    },
};
const createAI = (store, namespace) => realCreateAI(store, namespace, transport);
const tick = () => new Promise(r => setImmediate(r));
const preset = { id: 'p1', name: '简洁明快', description: '短句为主，动词优先。' };

function effectsCtx(chat) {
    const seed = { ...empty(), skills: [{ id: 's', name: '技能', book: 'b', entryId: '1', reminder: 'EFFECT-RULE' }] };
    const state = change(seed, chat, 'create', { skillId: 's', holder: 'a', target: 'b', scope: 'vision', condition: 'manual' });
    return { chat, chatMetadata: { [KEY]: state }, mockGenerate: async r => r.prompt };
}

test('stylewriter is a registered shared-AI app and rewrites via the shared service without effects or chat leakage', async () => {
    assert.ok(AI_APPS.some(a => a.id === 'stylewriter' && a.tasks.includes('文风转换')));
    const store = storage(), ai = createAI(store, 'sw-route');
    ai.settings.save({ ...ai.settings.snapshot(), enabled: true, baseUrl: 'https://global.test/v1', model: 'global' });
    ai.profiles.save('a', 'A', { ...ai.settings.snapshot(), baseUrl: 'https://a.test/v1', model: 'sw-model' });
    ai.setChannel('stylewriter', 'a');
    const ctx = effectsCtx([{ name: '艾琳', is_user: false, mes: '风声掠过塔顶。' }]);
    const seen = [];
    ctx.mockGenerate = async request => { seen.push(request); return '改写后的内容'; };
    const text = await rewriteText(ctx, buildRequest({ mode: 'custom', source: '原文内容', preset }), { service: ai });
    assert.equal(text, '改写后的内容');
    assert.equal(bodies.at(-1).body.model, 'sw-model');
    assert.match(seen[0].systemPrompt, /不补充原文没有的信息/);
    assert.match(seen[0].prompt, /原文内容/);
    assert.match(seen[0].prompt, /短句为主，动词优先。/);
    assert.ok(!seen[0].prompt.includes('艾琳'), 'custom mode must not leak chat prose');
    assert.ok(!seen[0].prompt.includes('EFFECT-RULE'), 'effect rules must not leak into rewrites');
    assert.ok(ai.tasks().some(t => t.app === '文风转换' && t.channel === 'A'));
    assert.ok(ai.previews().some(p => p.app === '文风转换'));
});

test('reference mode sends chat samples, custom mode sends none, and the source is never truncated', async () => {
    const store = storage(), ai = createAI(store, 'sw-samples');
    ai.settings.save({ ...ai.settings.snapshot(), enabled: true, baseUrl: 'https://global.test/v1', model: 'global' });
    const chat = [
        { name: '艾琳', is_user: false, mes: '风声掠过塔顶。' },
        { name: '我', is_user: true, mes: '我抬头看她。' },
        { name: 'sys', is_user: false, is_system: true, mes: 'HIDDEN-SYSTEM' },
    ];
    const ctx = { chat, mockGenerate: async r => r.prompt };
    const seen = [];
    ctx.mockGenerate = async r => { seen.push(r); return 'ok'; };
    assert.equal(await rewriteText(ctx, buildRequest({ mode: 'chat', source: '原文内容', samples: referenceSamples(ctx) }), { service: ai }), 'ok');
    assert.match(seen[0].prompt, /风声掠过塔顶。/);
    assert.ok(!seen[0].prompt.includes('HIDDEN-SYSTEM'));
    const long = '源'.repeat(30000);
    await rewriteText(ctx, buildRequest({ mode: 'custom', source: long, preset }), { service: ai });
    assert.ok(seen[1].prompt.includes(long));
    assert.ok(!seen[1].prompt.includes('艾琳'));
});

test('captured snapshot keeps channel after rebinding, and cancelling aborts the rewrite', async () => {
    const store = storage(), ai = createAI(store, 'sw-snap');
    ai.settings.save({ ...ai.settings.snapshot(), enabled: true, baseUrl: 'https://global.test/v1', model: 'global' });
    ai.profiles.save('a', 'A', { ...ai.settings.snapshot(), baseUrl: 'https://a.test/v1', model: 'sw-model' });
    ai.profiles.save('b', 'B', { ...ai.settings.snapshot(), baseUrl: 'https://b.test/v1', model: 'other' });
    ai.setChannel('stylewriter', 'a');
    const snapshot = ai.capture('stylewriter');
    ai.setChannel('stylewriter', 'b');
    const ctx = { chat: [], mockGenerate: async () => 'ok' };
    await ai.generate('文风转换', ctx, { systemPrompt: 'x', prompt: 'y' }, { snapshot });
    assert.equal(bodies.at(-1).body.model, 'sw-model');

    const store2 = storage(), ai2 = createAI(store2, 'sw-cancel');
    ai2.settings.save({ ...ai2.settings.snapshot(), enabled: true, baseUrl: 'https://global.test/v1', model: 'global', timeoutSeconds: 30 });
    let release;
    const ctx2 = { chat: [], mockGenerate: () => new Promise(r => release = r) };
    const running = rewriteText(ctx2, buildRequest({ mode: 'custom', source: 'x', preset }), { service: ai2 });
    await tick();
    const task = ai2.tasks().find(t => t.state === '等待模型 / 排队中');
    assert.ok(task, 'task should be queued');
    ai2.cancel(task.id);
    await assert.rejects(running);
    assert.ok(ai2.tasks().some(t => t.state === '已取消'));
    release?.('late');
});

test('writeToInput only writes a draft with an input event and never triggers send', () => {
    const events = [];
    const node = { value: '', dispatchEvent: event => events.push(event.type), focus() {}, setSelectionRange() {} };
    writeToInput(node, '新草稿');
    assert.equal(node.value, '新草稿');
    assert.deepEqual(events, ['input']);
    assert.equal(APP_TASK, '文风转换');
});

test('rewrite without a shared AI service fails with a clear message', async () => {
    assert.equal(getAI(), undefined);
    await assert.rejects(rewriteText({}, { systemPrompt: 'x', prompt: 'y' }), /共享 AI 设置/);
});
