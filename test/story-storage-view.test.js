import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryStorage } from '../settings/story-storage-view.js';
import { registerOperationPatchExpansion } from '../apps/shared/operations.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  click() { this.clicks = (this.clicks ?? 0) + 1; this.onclick?.(); }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const button = (root, label) => {
  const result = descendants(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.ok(result, `missing button: ${label}`);
  return result;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const recoveryError = '当前聊天的楼层变量尚未恢复完成';
const fileInput = target => descendants(target).find(node => node.tagName === 'INPUT' && node.type === 'file');
function pendingRecoveryFixture(runtime, chat = []) {
  const previousDocument = globalThis.document, previousHost = globalThis.SillyTavern;
  globalThis.document = { createElement: tag => new Element(tag), body: new Element('body') };
  const ctx = { chatMetadata: { integrity: 'pending-recovery' }, chatId: 'chat-a', chat };
  globalThis.SillyTavern = { getContext: () => ctx };
  const unregister = registerOperationPatchExpansion(patches => patches, null, () => { throw Error(recoveryError); });
  const messages = [], target = new Element('main');
  const view = mountStoryStorage(target, (message, state) => messages.push([message, state]), () => runtime);
  return { ctx, target, messages, dispose() {
    view.dispose(); unregister();
    globalThis.document = previousDocument; globalThis.SillyTavern = previousHost;
  } };
}

test('story storage setting enables the current chat and refreshes the displayed mode', async () => {
  globalThis.document = { createElement: tag => new Element(tag) };
  const ctx = { chatMetadata: { integrity: 'story-test' }, chatId: 'chat-a', chat: [] };
  globalThis.SillyTavern = { getContext: () => ctx };
  let enabled = false, calls = 0, scans = 0;
  const runtime = {
    storyStatus: () => ({ available: true, enabled, message: '文件接口可用。' }),
    enableStoryStorage: async () => { calls++; enabled = true; return { message: '新模式已启动。' }; },
    inspectStoryStorage: async () => { scans++; return { bytes: 2048, records: 2, checkpointCount: 1, deltaCount: 1, referenceBytes: 160 }; },
  };
  const messages = [], target = new Element('main');
  const view = mountStoryStorage(target, (message, state) => messages.push([message, state]), () => runtime);
  await tick();
  assert.match(target.textContent, /尚未启用/);
  assert.match(target.textContent, /按需扫描/);
  assert.equal(scans, 0);
  button(target, '为当前聊天启用文件存储').click();
  await tick();
  assert.equal(calls, 1);
  assert.match(target.textContent, /已启用/);
  assert.ok(messages.some(([message]) => message === '新模式已启动。'));
  assert.equal(button(target, '为当前聊天启用文件存储').disabled, true);
  button(target, '统计当前聊天占用').click();
  await tick();
  assert.equal(scans, 1);
  assert.match(target.textContent, /2 条记录/);
  assert.match(target.textContent, /消息引用 160 B/);
  view.dispose();
});

test('story backup import stops before writing if the chat switches while the file is read', async () => {
  globalThis.document = { createElement: tag => new Element(tag) };
  let current = { chatMetadata: { integrity: 'first' }, chatId: 'chat-a', chat: [] };
  globalThis.SillyTavern = { getContext: () => current };
  let resolveFile, imports = 0;
  const runtime = {
    storyStatus: () => ({ available: true, enabled: true }),
    importStory: async () => { imports++; },
  };
  const messages = [], target = new Element('main');
  const view = mountStoryStorage(target, (message, state) => messages.push([message, state]), () => runtime);
  await tick();
  button(target, '导入剧情备份文件').click();
  const input = descendants(target).find(node => node.tagName === 'INPUT' && node.type === 'file');
  input.files = [{ text: () => new Promise(resolve => { resolveFile = resolve; }) }];
  input.onchange();
  current = { chatMetadata: { integrity: 'second' }, chatId: 'chat-b', chat: [] };
  resolveFile('{"version":1}');
  await tick();
  assert.equal(imports, 0);
  assert.ok(messages.some(([message, state]) => /聊天或消息候选已变化/.test(message) && state === 'error'));
  view.dispose();
});

test('story file management remains available while floor recovery blocks variable writes', async () => {
  let imports = 0, exports = 0, inspections = 0, indexes = 0, restores = 0;
  const runtime = {
    ready: () => false,
    status: () => ({ ready: false, restoreError: recoveryError }),
    storyStatus: () => ({ available: true, enabled: true }),
    importStory: async bundle => { imports++; assert.deepEqual(bundle, { version: 1 }); return { message: '备份已导入。' }; },
    exportStory: async () => { exports++; return { version: 1 }; },
    inspectStoryStorage: async () => { inspections++; return { bytes: 64, records: 1 }; },
    inspectStoryIndex: async () => { indexes++; return { rows: [], states: 0, unreadableStates: 0, baseHealth: { readable: true }, indexed: true }; },
    restoreChat: async () => { restores++; },
  };
  const fixture = pendingRecoveryFixture(runtime);
  try {
    await tick();
    const picker = fileInput(fixture.target);
    assert.equal(button(fixture.target, '导入剧情备份文件').disabled, false);
    button(fixture.target, '导入剧情备份文件').click();
    assert.equal(picker.clicks, 1, 'the file picker must open despite the variable preparation error');
    picker.files = [{ text: async () => '{"version":1}' }];
    picker.onchange();
    await tick();
    assert.equal(imports, 1);
    assert.equal(restores, 0, 'import must leave restoration to the explicit retry action');
    assert.ok(fixture.messages.some(([message]) => message === '备份已导入。'));
    button(fixture.target, '导出当前聊天剧情备份').click();
    await tick();
    assert.equal(exports, 1);
    button(fixture.target, '统计当前聊天占用').click();
    await tick();
    assert.equal(inspections, 1);
    assert.match(fixture.target.textContent, /1 条记录/);
    button(fixture.target, '检查楼层与 Swipe 存档').click();
    await tick();
    assert.equal(indexes, 1);
    assert.match(fixture.target.textContent, /当前聊天存档索引/);
  } finally { fixture.dispose(); }
});

test('enabling story storage still refuses an unfinished variable recovery', async () => {
  let enables = 0;
  const runtime = {
    ready: () => false,
    storyStatus: () => ({ available: true, enabled: false }),
    enableStoryStorage: async () => { enables++; },
  };
  const fixture = pendingRecoveryFixture(runtime);
  try {
    await tick();
    button(fixture.target, '为当前聊天启用文件存储').click();
    await tick();
    assert.equal(enables, 0, 'enable must still pass the variable write preparation guard');
    assert.ok(fixture.messages.some(([message, state]) => message === recoveryError && state === 'error'));
  } finally { fixture.dispose(); }
});

for (const change of ['integrity', 'swipe']) {
  test(`story backup import cancels when ${change} changes during the file read`, async () => {
    let resolveFile, imports = 0;
    const runtime = {
      ready: () => false,
      storyStatus: () => ({ available: true, enabled: true }),
      importStory: async () => { imports++; },
    };
    const fixture = pendingRecoveryFixture(runtime, [{ name: 'assistant', is_user: false, mes: 'first', swipe_id: 0, swipes: ['first', 'second'] }]);
    try {
      await tick();
      button(fixture.target, '导入剧情备份文件').click();
      const picker = fileInput(fixture.target);
      picker.files = [{ text: () => new Promise(resolve => { resolveFile = resolve; }) }];
      picker.onchange();
      assert.equal(typeof resolveFile, 'function');
      if (change === 'integrity') fixture.ctx.chatMetadata.integrity = 'replacement-payload';
      else { fixture.ctx.chat[0].swipe_id = 1; fixture.ctx.chat[0].mes = 'second'; }
      resolveFile('{"version":1}');
      await tick();
      assert.equal(imports, 0);
      assert.ok(fixture.messages.some(([message, state]) => /聊天或消息候选已变化/.test(message) && state === 'error'));
    } finally { fixture.dispose(); }
  });
}

test('explicit story recovery retry reports success only after the runtime becomes ready', async () => {
  let ready = false, restores = 0;
  const runtime = {
    ready: () => ready,
    status: () => ({ ready, restoreError: ready ? '' : recoveryError }),
    storyStatus: () => ({ available: true, enabled: true }),
    restoreChat: async () => { restores++; ready = true; return false; },
  };
  const fixture = pendingRecoveryFixture(runtime);
  try {
    await tick();
    assert.match(fixture.target.textContent, new RegExp(recoveryError));
    button(fixture.target, '重试恢复当前分支').click();
    await tick();
    assert.equal(restores, 1);
    assert.ok(fixture.messages.some(([message, state]) => /恢复/.test(message) && state !== 'error'));
    assert.doesNotMatch(fixture.target.textContent, new RegExp(recoveryError));
  } finally { fixture.dispose(); }
});

test('story recovery retry exposes the runtime restoration failure instead of reporting success', async () => {
  const actualError = '剧情状态 sha256:test 的父文件缺失';
  let restores = 0, restoreError = recoveryError;
  const runtime = {
    ready: () => false,
    status: () => ({ ready: false, restoreError }),
    storyStatus: () => ({ available: true, enabled: true, message: '文件接口可用。' }),
    restoreChat: async () => { restores++; restoreError = actualError; return true; },
  };
  const fixture = pendingRecoveryFixture(runtime);
  try {
    await tick();
    button(fixture.target, '重试恢复当前分支').click();
    await tick();
    assert.equal(restores, 1);
    assert.ok(fixture.messages.some(([message, state]) => message.includes(actualError) && state === 'error'));
    assert.match(fixture.target.textContent, new RegExp(actualError));
    assert.equal(button(fixture.target, '导入剧情备份文件').disabled, false);
    assert.equal(button(fixture.target, '重试恢复当前分支').disabled, false);
  } finally { fixture.dispose(); }
});

for (const mode of ['streaming', 'nonstreaming']) {
  test(`story recovery retry refuses an active ${mode} generation`, async () => {
    let generating = false, restores = 0;
    const runtime = {
      ready: () => false,
      status: () => ({ ready: false, generating, restoreError: recoveryError }),
      storyStatus: () => ({ available: true, enabled: true }),
      restoreChat: async () => { restores++; },
    };
    const fixture = pendingRecoveryFixture(runtime);
    try {
      await tick();
      const retry = button(fixture.target, '重试恢复当前分支');
      assert.equal(retry.disabled, false);
      // Generation can start after the controls were rendered. The action must
      // check the live state as well as disabling the button during refresh.
      if (mode === 'streaming') fixture.ctx.streamingProcessor = { isFinished: false };
      else generating = true;
      retry.click();
      await tick();
      assert.equal(restores, 0);
      assert.ok(fixture.messages.some(([message, state]) => /等待生成结束/.test(message) && state === 'error'));
      if (mode === 'nonstreaming') assert.equal(retry.disabled, true);
    } finally { fixture.dispose(); }
  });
}
