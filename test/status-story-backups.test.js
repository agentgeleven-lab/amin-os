import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStoryBackup, recordStoryBackup, storyBackups, usesStoryStorage } from '../apps/status/story-backups.js';

test('short external recovery references are bounded and leave legacy manual backups intact',async()=>{
  const ctx={chatMetadata:{amin_os_story_storage_v2:{version:2},variables:{状态栏_生成前备份_手工:'old'}}};
  assert.equal(usesStoryStorage(ctx),true);
  for(let i=0;i<7;i++){
    const stateId='sha256:'+i.toString(16).repeat(64);
    const backup=await captureStoryBackup(ctx,{label:'手动另存状态',archive:async()=>({stateId})});
    recordStoryBackup(ctx,backup);
  }
  assert.equal(storyBackups(ctx).length,5);
  assert.equal(storyBackups(ctx)[0].stateId,'sha256:'+'2'.repeat(64));
  assert.equal(ctx.chatMetadata.variables.状态栏_生成前备份_手工,'old');
  assert.deepEqual(Object.keys(ctx.chatMetadata.variables),['状态栏_生成前备份_手工']);
});

test('malformed recovery references are never overwritten as a side effect of saving',()=>{
  const ctx={chatMetadata:{amin_os_story_storage_v2:{version:2,backups:[{stateId:'bad',label:'手工',at:1}]}}};
  assert.throws(()=>recordStoryBackup(ctx,{stateId:'sha256:'+'f'.repeat(64),label:'新',at:2}),/格式无效/);
  assert.equal(ctx.chatMetadata.amin_os_story_storage_v2.backups[0].stateId,'bad');
});
