import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { STATE_KEY, isIndependent, readStoryRoot, writeStoryRoot, prepareIndependentManualWrite } from '../apps/story-state/access.js';
import { emptyState } from '../apps/story-state/schema.js';
import { createStoryStateRuntime } from '../apps/story-state/runtime.js';
import { captureContext, assertContext, acquireMetadataWrite } from '../apps/shared/operations.js';
import { saveChatMetadata } from '../apps/shared/chat-save.js';
import '../apps/status/story-state.js';

const status = value => ({版本:1,项目:{人物:{生命:value}}});

function persistenceHelper(ctx) {
    // Exercise the actual UI helper while retaining real transaction tokens.
    // Rendering and history observation have no bearing on save validity.
    const source = readFileSync(new URL('../apps/status/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function persistStatusChange(');
    const end = source.indexOf('\nfunction syncHistory()', start);
    assert.ok(start >= 0 && end > start, 'status persistence helper is available');
    const sandbox = {context:()=>ctx, captureContext, assertContext, acquireMetadataWrite,
        isIndependent, readStoryRoot, writeStoryRoot, prepareIndependentManualWrite,
        saveChatMetadata, history:{adoptExternal(){}}};
    vm.runInNewContext(source.slice(start,end)+'\nglobalThis.persist = persistStatusChange;',sandbox);
    return sandbox.persist;
}

test('independent status UI persistence validates its saved revision rather than its own previous revision', async () => {
    let saves = 0;
    const ctx = { characterId:0, characters:[{avatar:'test.png'}], getCurrentChatId:()=> 'status-ui',
        chat:[{mes:'test'}], chatMetadata:{variables:{unrelated:'keep'},
            [STATE_KEY]:{...emptyState(), modules:{...emptyState().modules,status:status(1)}}},
        saveMetadata:async()=> { saves++; } };
    const runtime = createStoryStateRuntime(()=>ctx, {backups:{available:()=>false,
        status:()=>({available:false}),savePrevious:async()=>{}}});
    try {
        await persistenceHelper(ctx)(()=>writeStoryRoot(ctx,'状态栏',JSON.stringify(status(2))));
        assert.equal(saves,1);
        assert.deepEqual(ctx.chatMetadata[STATE_KEY].modules.status,status(2));
        assert.deepEqual(ctx.chatMetadata.variables,{unrelated:'keep'});
    } finally { runtime.destroy(); }
});

for (const change of ['chat', 'canonical']) test(`independent status UI rejects ${change} changes during backup before dispatching host save`, async () => {
    let saves = 0, entered, resume;
    const waiting = new Promise(resolve=> { entered=resolve; });
    const paused = new Promise(resolve=> { resume=resolve; });
    const ctx = {characterId:0,characters:[{avatar:'test.png'}],chatId:'status-ui',getCurrentChatId(){return this.chatId;},
        chat:[{mes:'test'}],chatMetadata:{variables:{unrelated:'keep'},
            [STATE_KEY]:{...emptyState(),modules:{...emptyState().modules,status:status(1)}}},
        saveMetadata:async()=> {saves++;}};
    const runtime = createStoryStateRuntime(()=>ctx,{backups:{available:()=>true,status:()=>({available:true}),
        savePrevious:async()=> {entered();await paused;}}});
    try {
        const pending = persistenceHelper(ctx)(()=>writeStoryRoot(ctx,'状态栏',JSON.stringify(status(2))));
        const rejected = assert.rejects(pending,/已变化|变化|重新预览/u);
        await waiting;
        if (change === 'chat') ctx.chatId='another-chat';
        else ctx.chatMetadata[STATE_KEY].modules.status=status(3);
        resume();
        await rejected;
        assert.equal(saves,0,'a stale operation never dispatches a save to the host');
    } finally {resume();runtime.destroy();}
});
