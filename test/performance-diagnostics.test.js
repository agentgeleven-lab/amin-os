import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceDiagnostics, performanceDiagnostics } from '../apps/shared/performance-diagnostics.js';
import { saveChatMetadata, markChatIdsDirty } from '../apps/shared/chat-save.js';

test('performance diagnostics are opt-in, bounded and discard stopped or reset in-flight measurements', () => {
    let time = 0; const d = createPerformanceDiagnostics({now:()=>time,maxSamples:3});
    d.begin('restore')();assert.equal(d.snapshot().rows.length,0);
    d.start();for(let n=0;n<5;n++){const done=d.begin('fileWrite');time+=n+1;done({bytes:10});done({bytes:999});}
    const row=d.snapshot().rows[0];assert.equal(row.count,5);assert.equal(row.sampleCount,3);assert.equal(row.bytes,50);assert.equal(row.p95Ms,5);
    const stopped=d.begin('restore');d.stop();stopped();assert.equal(d.snapshot().rows.length,1);
    d.start();const old=d.begin('restore');d.reset();old();assert.equal(d.snapshot().rows.length,0);
    d.begin('private-chat-name')();assert.equal(d.snapshot().rows.length,0);
});

test('Amin host saves count successful and failed invocations without storing chat content', async () => {
    const ctx={chatMetadata:{},getCurrentChatId:()=> 'secret-name',saveMetadata:async()=>{},saveChat:async()=>{throw Error('private failure');}};
    performanceDiagnostics.start();try{
        await saveChatMetadata(ctx);markChatIdsDirty(ctx);await assert.rejects(saveChatMetadata(ctx),/private failure/);
        const snapshot=performanceDiagnostics.snapshot();assert.equal(snapshot.rows.find(r=>r.kind==='metadataSave').count,1);
        assert.equal(snapshot.rows.find(r=>r.kind==='chatSave').failures,1);
        assert.doesNotMatch(JSON.stringify(snapshot),/secret-name|private failure/);
    }finally{performanceDiagnostics.stop();performanceDiagnostics.reset();}
});
