import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, SCOPE_TEMPLATE_KEY, emptyLinkageState, scopeTemplate, readLinkageState, readLinkageSettings, mayWrite } from '../apps/linkage/policy.js';
import { createLinkageService } from '../apps/linkage/service.js';

const scope = () => ({ enabled: true, modules: { characters: { enabled: true, read: true, write: true } } });
test('unconfigured chats inherit global scope without writing metadata or copying chat data', () => {
    const template = scopeTemplate({ ...scope(), extraRules: 'private', links: [{ id: 'private' }], applied: ['private'], contextBudget: { entrySelection: { pinned: ['characters:alice'] } } });
    assert.deepEqual(Object.keys(template).sort(), ['enabled', 'modules', 'version']);
    const ctx = { chatMetadata: {}, extensionSettings: { [SCOPE_TEMPLATE_KEY]: template } };
    assert.equal(mayWrite(ctx, 'characters'), true);
    assert.equal(mayWrite(ctx, 'inventory'), false);
    assert.equal(readLinkageState(ctx).extraRules, '');
    assert.deepEqual(readLinkageState(ctx).links, []);
    assert.deepEqual(ctx.chatMetadata, {});
    readLinkageSettings(ctx).modules.characters.write = false;
    assert.equal(template.modules.characters.write, true);
});
test('explicit chat settings and cloned branch settings win even when disabled', () => {
    const ctx = { chatMetadata: { [KEY]: emptyLinkageState() }, extensionSettings: { [SCOPE_TEMPLATE_KEY]: scopeTemplate(scope()) } };
    assert.equal(readLinkageState(ctx).enabled, false);
    assert.equal(mayWrite({ ...ctx, chatMetadata: structuredClone(ctx.chatMetadata) }, 'characters'), false);
    assert.throws(() => scopeTemplate({ enabled: true, modules: { dice: { enabled: true, read: true, write: true } } }), /开关/);
});
test('saving a global template uses host settings only and rolls back reported failures', async () => {
    let fail = false, saves = 0;
    const ctx = { getCurrentChatId: () => 'chat', chat: [], chatMetadata: { [KEY]: { ...emptyLinkageState(), ...scope(), extraRules: 'private' } }, extensionSettings: { unrelated: 'keep' },
        saveSettingsDebounced: async () => { saves++; if (fail) throw Error('offline'); } };
    const before = structuredClone(ctx.chatMetadata);
    const api = createLinkageService(() => ctx, { adapters: [] });
    try {
        await api.saveScopeTemplate();
        assert.equal(saves, 1);
        assert.deepEqual(ctx.chatMetadata, before);
        assert.equal(ctx.extensionSettings.unrelated, 'keep');
        const saved = structuredClone(ctx.extensionSettings[SCOPE_TEMPLATE_KEY]);
        fail = true; ctx.chatMetadata[KEY].enabled = false;
        await assert.rejects(api.saveScopeTemplate(), /offline/);
        assert.deepEqual(ctx.extensionSettings[SCOPE_TEMPLATE_KEY], saved);
        assert.equal(api.busy(), false);
        delete ctx.saveSettingsDebounced;
        await assert.rejects(api.saveScopeTemplate(), /接口/);
    } finally { api.dispose(); }
});
