import test from 'node:test';
import assert from 'node:assert/strict';
import { markChatIdsDirty, saveChatMetadata } from '../apps/shared/chat-save.js';
import { createHistory } from '../apps/status/history.js';

const fixture = () => {
  let chatSaves = 0, metadataSaves = 0;
  const ctx = {
    chatMetadata: {}, chat: [{ mes: '第一楼', extra: {} }],
    getCurrentChatId: () => 'chapter',
    saveChat: async () => { chatSaves++; },
    saveMetadata: async () => { metadataSaves++; },
  };
  return { ctx, chatSaves: () => chatSaves, metadataSaves: () => metadataSaves };
};

test('pending floor IDs use one full save, then ordinary metadata saves resume', async () => {
  const t = fixture(); markChatIdsDirty(t.ctx);
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(t.chatSaves(), 1); assert.equal(t.metadataSaves(), 0);
  assert.equal(await saveChatMetadata(t.ctx), 'metadata');
  assert.equal(t.chatSaves(), 1); assert.equal(t.metadataSaves(), 1);
});

test('a full save failure retains pending floor IDs for the next attempt', async () => {
  const t = fixture(); let calls = 0;
  t.ctx.saveChat = async () => { calls++; if (calls === 1) throw Error('disk busy'); };
  markChatIdsDirty(t.ctx);
  await assert.rejects(saveChatMetadata(t.ctx), /disk busy/);
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(calls, 2); assert.equal(t.metadataSaves(), 0);
});

test('an ID assigned during an in-flight full save remains pending', async () => {
  const t = fixture(); let finishFirst, calls = 0;
  t.ctx.saveChat = () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve();
  };
  markChatIdsDirty(t.ctx);
  const first = saveChatMetadata(t.ctx);
  markChatIdsDirty(t.ctx);
  finishFirst(); await first;
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.equal(calls, 2); assert.equal(t.metadataSaves(), 0);
});

test('an external update persists history and its message IDs together across reload', async () => {
  const t = fixture(); let state = { hp: 8 }, saved;
  t.ctx.saveChat = async () => {
    saved = { chat: structuredClone(t.ctx.chat), chatMetadata: structuredClone(t.ctx.chatMetadata) };
  };
  const history = createHistory({ context: () => t.ctx, read: () => state, write: value => { state = value; } });
  history.sync();
  assert.equal(saved, undefined); assert.equal(t.metadataSaves(), 0);
  state = { hp: 17 }; history.adoptExternal();
  assert.equal(await saveChatMetadata(t.ctx), 'chat');
  assert.ok(saved.chat[0].extra.wsh_message_id);
  const restored = { ...t.ctx, ...saved, saveChat: async () => {}, saveMetadata: async () => {} };
  const reloaded = createHistory({ context: () => restored, read: () => ({ hp: 17 }), write: () => {} });
  reloaded.sync();
  assert.deepEqual(reloaded.list()[0].state, { hp: 17 });
  assert.equal(t.metadataSaves(), 0);
  history.dispose(); reloaded.dispose();
});
