import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HISTORY_KEY } from '../apps/status/history.js';
import { historyView } from '../apps/status/history-ui.js';

function fixture(readFloor = async index => ({项目:{楼层:{值:index}}})) {
  let saves = 0, current = 'chat-a';
  const ctx = {
    chatMetadata: { amin_os_story_storage_v2: {version:2}, variables:{状态栏:'current'} },
    chat: [{name:'旧楼', mes:'A', extra:{}}, {name:'新楼', mes:'B', extra:{}}],
    getCurrentChatId:()=>current, saveChat:async()=>{saves++;}, saveMetadata:async()=>{saves++;},
  };
  const history = createHistory({context:()=>ctx, read:()=>({项目:{当前:{值:99}}}), write:()=>{throw Error('must not write');}, externalRead:readFloor});
  return {ctx,history,saves:()=>saves,switchChat:()=>{current='chat-b';}};
}

test('external history observes floors without adding IDs, snapshots or chat saves', async () => {
  const f = fixture();
  f.history.sync();
  assert.deepEqual(f.ctx.chat.map(m=>m.extra), [{},{}]);
  assert.equal(f.ctx.chatMetadata[HISTORY_KEY], undefined);
  assert.equal(f.history.list()[0].external, true);
  assert.equal(f.history.list()[0].state, undefined);
  assert.deepEqual((await f.history.readFloor(0)).state, {项目:{楼层:{值:0}}});
  assert.equal(f.history.adoptExternal(), true);
  assert.equal(f.saves(), 0);
  assert.equal(f.ctx.chatMetadata[HISTORY_KEY], undefined);
  f.history.dispose();
});

test('external history rejects an old asynchronous floor result after the chat or candidate changes', async () => {
  for (const change of [f=>f.switchChat(),f=>{f.ctx.chat[0].swipe_id=1;},f=>{f.ctx.chat[0].extra.amin_story_v2={stateId:'new'};},f=>{f.ctx.chat[0].mes='edited';},f=>{f.ctx.chatMetadata.amin_os_story_storage_v2.indexId='new-index';}]) {
    let resolve;
    const f = fixture(()=>new Promise(done=>{resolve=done;}));
    f.history.sync();
    const read = f.history.readFloor(0);
    change(f);
    resolve({项目:{未来:{值:1}}});
    await assert.rejects(read,/聊天或楼层已变化/);
    f.history.dispose();
  }
});

for (const legacy of [false, true]) {
  test(`current-only status history never stores floors or exposes legacy snapshots (legacy marker ${legacy})`, async () => {
    const reads = [];
    const f = fixture(async index => {
      reads.push(index);
      if (index !== f.ctx.chat.length - 1) throw Error('当前变量模式不保存旧楼层或 Swipe 状态。');
      return { 项目: { 当前: { 值: 99 } } };
    });
    f.ctx.chatMetadata.amin_os_current_story_v1 = { version: 1, key: 'current-test', revision: 1 };
    if (!legacy) delete f.ctx.chatMetadata.amin_os_story_storage_v2;
    f.ctx.chat[0].extra.wsh_message_id = 'old-message';
    f.ctx.chatMetadata[HISTORY_KEY] = { records: { 'old-message:0': { state: { 项目: { 旧: { 值: 1 } } }, savedAt: 123 } } };
    const beforeMetadata = structuredClone(f.ctx.chatMetadata), beforeMessages = structuredClone(f.ctx.chat);
    try {
      f.history.sync();
      assert.deepEqual(f.history.list().map(row => row.available), [false, true]);
      assert.equal(f.history.list()[0].state, undefined);
      assert.equal(f.history.list()[0].savedAt, undefined);
      await assert.rejects(f.history.readFloor(0), /不保存旧楼层或 Swipe/);
      assert.deepEqual((await f.history.readFloor(1)).state, { 项目: { 当前: { 值: 99 } } });
      assert.deepEqual(reads, [0, 1], 'old-floor requests must receive the runtime no-history result');
      assert.equal(f.history.adoptExternal(), true);
      assert.deepEqual(f.ctx.chatMetadata, beforeMetadata);
      assert.deepEqual(f.ctx.chat, beforeMessages);
      assert.equal(f.saves(), 0);
    } finally { f.history.dispose(); }
  });
}

test('current-only status history rejects a pending current read after record revision changes', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.ctx.chatMetadata.amin_os_current_story_v1 = { version: 1, key: 'current-test', revision: 1 };
  try {
    f.history.sync();
    const read = f.history.readFloor(1);
    f.ctx.chatMetadata.amin_os_current_story_v1.revision = 2;
    resolve({ 项目: {} });
    await assert.rejects(read, /聊天或楼层已变化/);
  } finally { f.history.dispose(); }
});

class Node {
  constructor(tag,text='',className=''){this.tag=tag;this.textContent=text;this.className=className;this.children=[];this.disabled=false;this.classList={add:name=>{this.className+=' '+name;}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
}
const content=node=>[node.textContent,...node.children.flatMap(content)].join(' ');

test('historical window loads external state and shows a clear read failure', async () => {
  const f = fixture(async index=>index===0?{项目:{场景:{位置:'城门'}}}:Promise.reject(Error('外置文件缺失')));
  f.history.sync();
  const view = historyView({history:f.history,node:(...args)=>new Node(...args),floor:0});
  assert.match(content(view.element),/正在读取此楼层/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(content(view.element),/城门/);
  const right=view.element.children[0].children[2];right.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(content(view.element),/外置文件缺失/);
  assert.doesNotMatch(content(view.element),/城门/);
  view.dispose();f.history.dispose();
});
