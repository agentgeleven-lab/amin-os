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
const fileInput = target => descendants(target).find(node => node.tagName === 'INPUT' && node.type === 'file' && node.accept === '.json,application/json');
const originalChatInput = target => descendants(target).find(node => node.tagName === 'INPUT' && node.type === 'file' && node.accept === '.jsonl,application/x-ndjson');
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

function identityRecoveryFixture(overrides = {}) {
  const opaquePlan = Object.freeze({ opaque: 'verified-plan' });
  const calls = { inspect: 0, repair: 0, restore: 0, import: 0 };
  let ready = false;
  const runtime = {
    ready: () => ready,
    status: () => ({ ready, restoreError: ready ? '' : recoveryError }),
    storyStatus: () => ({ available: true, enabled: true }),
    inspectStoryIdentityRecovery: async text => {
      calls.inspect++;
      assert.equal(text, 'original chat JSONL');
      return { plan: opaquePlan, rows: [{ floor: 0, swipe: 0, oldId: 'copied-id', newId: 'original-id', stateId: null }], mirrors: [] };
    },
    repairStoryIdentities: async supplied => {
      calls.repair++;
      assert.equal(supplied, opaquePlan, 'apply must pass the exact opaque plan returned by inspection');
      return { message: '候选标识已修复。' };
    },
    restoreChat: async () => { calls.restore++; ready = true; },
    importStory: async () => { calls.import++; return { message: '备份已导入。' }; },
    ...overrides,
  };
  const fixture = pendingRecoveryFixture(runtime, [{ name: 'assistant', is_user: false, mes: 'first', swipe_id: 0, swipes: ['first', 'second'] }]);
  return { ...fixture, opaquePlan, calls };
}
async function previewIdentityRepair(fixture) {
  button(fixture.target, '用原聊天校验 Swipe 标识').click();
  const input = originalChatInput(fixture.target);
  assert.ok(input, 'identity recovery must use a separate original JSONL file input');
  input.files = [{ text: async () => 'original chat JSONL' }];
  input.onchange();
  await tick();
}

test('original-chat recovery previews without writing, applies only its verified plan, then requires explicit retry', async () => {
  const fixture = identityRecoveryFixture();
  try {
    await tick();
    const before = structuredClone(fixture.ctx);
    const apply = button(fixture.target, '应用标识修复');
    assert.equal(apply.disabled, true);
    assert.ok(fileInput(fixture.target), 'backup JSON input must remain available');
    await previewIdentityRepair(fixture);
    assert.equal(originalChatInput(fixture.target).clicks, 1);
    assert.equal(fixture.calls.inspect, 1);
    assert.equal(fixture.calls.repair, 0);
    assert.equal(fixture.calls.restore, 0);
    assert.deepEqual(fixture.ctx, before, 'the preview must not change live chat data');
    assert.equal(apply.disabled, false);
    assert.match(fixture.target.textContent, /original-id/);
    apply.click();
    await tick();
    assert.equal(fixture.calls.repair, 1);
    assert.equal(fixture.calls.restore, 0, 'identity repair must not auto-restore variables');
    assert.equal(apply.disabled, true, 'successful apply must clear the preview');
    assert.ok(fixture.messages.some(([message]) => message === '候选标识已修复。'));
    button(fixture.target, '重试恢复当前分支').click();
    await tick();
    assert.equal(fixture.calls.restore, 1);
    assert.ok(fixture.messages.some(([message, state]) => /恢复/.test(message) && state !== 'error'));
  } finally { fixture.dispose(); }
});

test('identity recovery buttons remain unavailable when their runtime APIs are absent', async () => {
  const fixture = identityRecoveryFixture({ inspectStoryIdentityRecovery: undefined, repairStoryIdentities: undefined });
  try {
    await tick();
    assert.equal(button(fixture.target, '用原聊天校验 Swipe 标识').disabled, true);
    assert.equal(button(fixture.target, '应用标识修复').disabled, true);
    assert.equal(button(fixture.target, '导入剧情备份文件').disabled, false);
  } finally { fixture.dispose(); }
});

test('identity recovery controls are disabled while source inspection is pending', async () => {
  let resolveInspection;
  const fixture = identityRecoveryFixture({ inspectStoryIdentityRecovery: () => new Promise(resolve => { resolveInspection = resolve; }) });
  try {
    await tick();
    await previewIdentityRepair(fixture);
    assert.equal(typeof resolveInspection, 'function');
    assert.equal(button(fixture.target, '用原聊天校验 Swipe 标识').disabled, true);
    assert.equal(button(fixture.target, '应用标识修复').disabled, true);
    resolveInspection({ plan: fixture.opaquePlan, rows: [{ floor: 0, swipe: 0, oldId: 'copied-id', newId: 'original-id', stateId: null }], mirrors: [] });
    await tick();
    assert.equal(button(fixture.target, '用原聊天校验 Swipe 标识').disabled, false);
    assert.equal(button(fixture.target, '应用标识修复').disabled, false);
  } finally { fixture.dispose(); }
});

for (const changeCount of ['none', 'mirror']) {
  test(`identity recovery apply availability follows ${changeCount} preview changes`, async () => {
    const fixture = identityRecoveryFixture({ inspectStoryIdentityRecovery: async () => ({
      plan: {}, rows: [], mirrors: changeCount === 'mirror' ? [{ floor: 0, oldId: 'old-mirror', newId: 'new-mirror' }] : [],
    }) });
    try {
      await tick();
      await previewIdentityRepair(fixture);
      assert.equal(button(fixture.target, '应用标识修复').disabled, changeCount === 'none');
    } finally { fixture.dispose(); }
  });
}

for (const stage of ['file read', 'preview to apply']) {
  for (const change of ['chat', 'candidate']) {
    test(`identity recovery rejects a ${change} change during ${stage}`, async () => {
      const fixture = identityRecoveryFixture();
      try {
        await tick();
        let resolveFile;
        if (stage === 'file read') {
          button(fixture.target, '用原聊天校验 Swipe 标识').click();
          const input = originalChatInput(fixture.target);
          input.files = [{ text: () => new Promise(resolve => { resolveFile = resolve; }) }];
          input.onchange();
          assert.equal(typeof resolveFile, 'function');
        } else await previewIdentityRepair(fixture);
        if (change === 'chat') fixture.ctx.chatId = 'different-chat';
        else fixture.ctx.chat[0].swipes[1] = 'changed unselected candidate';
        if (stage === 'file read') resolveFile('original chat JSONL');
        else button(fixture.target, '应用标识修复').click();
        await tick();
        assert.equal(fixture.calls.repair, 0);
        if (stage === 'file read') assert.equal(fixture.calls.inspect, 0);
        assert.ok(fixture.messages.some(([message, state]) => /聊天或消息候选已变化/.test(message) && state === 'error'));
      } finally { fixture.dispose(); }
    });
  }
}

for (const action of ['import', 'retry', 'dispose']) {
  test(`identity recovery discards its preview after ${action}`, async () => {
    const fixture = identityRecoveryFixture();
    let disposed = false;
    try {
      await tick();
      await previewIdentityRepair(fixture);
      const apply = button(fixture.target, '应用标识修复');
      assert.equal(apply.disabled, false);
      if (action === 'import') {
        button(fixture.target, '导入剧情备份文件').click();
        const input = fileInput(fixture.target);
        input.files = [{ text: async () => '{"version":1}' }];
        input.onchange();
      } else if (action === 'retry') button(fixture.target, '重试恢复当前分支').click();
      else { fixture.dispose(); disposed = true; }
      await tick();
      assert.equal(apply.disabled, true);
      assert.equal(fixture.calls.repair, 0);
      if (action === 'import') assert.equal(fixture.calls.import, 1);
    } finally { if (!disposed) fixture.dispose(); }
  });
}
