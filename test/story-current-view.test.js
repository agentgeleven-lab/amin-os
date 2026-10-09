import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryStorage } from '../settings/story-storage-view.js';
import { registerOperationPatchExpansion } from '../apps/shared/operations.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.className = ''; this.hidden = false; this.disabled = false; this.value = '';
  }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  click() { this.onclick?.(); }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const visible = node => !node.hidden && (!node.parentElement || visible(node.parentElement));
const button = (root, label) => {
  const node = descendants(root).find(item => item.tagName === 'BUTTON' && item.textContent === label);
  assert.ok(node, `missing button: ${label}`); return node;
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const ownedLabels = ['人物', '背包', '关系', '场景', '剧情', '持续效果', '地图', '信息', '骰子', '世界状态', '势力资料'];

function fixture({ current = false, blocked = false, overrides = {} } = {}) {
  const previousDocument = globalThis.document, previousHost = globalThis.SillyTavern;
  globalThis.document = { createElement: tag => new Element(tag), body: new Element('body') };
  let ctx = { chatId: 'chat-a', chatMetadata: {
    integrity: 'a', variables: { 状态栏: '{"name":"before"}', unrelated: 'keep' },
    LWB_RULES_V2: { 状态栏: { type: 'object' }, unrelated: { type: 'string' } },
  }, chat: [{ name: 'assistant', mes: 'original prose', swipe_id: 0, swipes: ['original prose', 'other prose'] }] };
  globalThis.SillyTavern = { getContext: () => ctx };
  const unregister = blocked ? registerOperationPatchExpansion(patches => patches, null, () => {
    throw Error('native recovery blocked');
  }) : () => {};
  let enabledCurrent = current;
  const calls = { switch: [], reset: 0, inspect: 0, restore: [], legacyRestore: 0, imports: [] };
  const runtime = {
    ready: () => !blocked,
    status: () => ({ ready: !blocked, restoring: false, generating: false,
      restoreError: blocked ? '重复 Swipe 标识' : '' }),
    storyStatus: () => ({ available: true, enabled: true,
      mode: enabledCurrent ? 'current-only' : 'history', currentOnly: enabledCurrent, backupCount: enabledCurrent ? 2 : 0 }),
    switchToCurrentStory: async options => { calls.switch.push(options); enabledCurrent = true; return { message: '已切换简洁存储。' }; },
    resetCurrentStory: async () => { calls.reset++; enabledCurrent = true; return { message: '已备份并清空。' }; },
    inspectCurrentStoryBackups: async () => {
      calls.inspect++; return { backups: [
        { index: 0, at: 1710000000000, label: 'first backup', hash: 'sha256:first' },
        { index: 1, at: 1710000001000, label: 'second backup', hash: 'sha256:second' },
      ] };
    },
    restoreCurrentStoryBackup: async (index, options) => { calls.restore.push([index, options]); return { message: '已恢复所选备份。' }; },
    inspectStoryIndex: async () => ({ rows: [], states: 0, unreadableStates: 0, baseHealth: { readable: true } }),
    inspectStoryIdentityRecovery: async () => { throw Error('should not inspect legacy source'); },
    restoreChat: async () => { calls.legacyRestore++; },
    importStory: async bundle => { calls.imports.push(bundle); return { message: '变量备份已导入。' }; },
    ...overrides,
  };
  const messages = [], target = new Element('main');
  const view = mountStoryStorage(target, (message, state) => messages.push([message, state]), () => runtime);
  return { target, messages, calls, runtime, view, get ctx() { return ctx; },
    switchChat() { ctx = { chatId: 'chat-b', chatMetadata: { integrity: 'b', variables: {} }, chat: [] }; },
    dispose() { view.dispose(); unregister(); globalThis.document = previousDocument; globalThis.SillyTavern = previousHost; },
  };
}

test('switching to current-only explicitly preserves variables even while native restoration is blocked', async () => {
  const f = fixture({ blocked: true });
  try {
    await tick(); const before = structuredClone(f.ctx);
    button(f.target, '改用简洁存储（保留当前变量）').click(); await tick();
    assert.deepEqual(f.calls.switch, [{ clear: false }]);
    assert.equal(f.calls.reset, 0); assert.equal(f.calls.legacyRestore, 0);
    assert.deepEqual(f.ctx, before);
    assert.ok(f.messages.some(([text, state]) => text === '已切换简洁存储。' && state !== 'error'));
  } finally { f.dispose(); }
});

test('reset requires a review of all owned roots and a second explicit click', async () => {
  const f = fixture({ blocked: true });
  try {
    await tick(); const before = structuredClone(f.ctx);
    button(f.target, '备份并清空当前变量').click(); await tick();
    assert.equal(f.calls.reset, 0);
    for (const label of ownedLabels) assert.ok(f.target.textContent.includes(label), `review missing owned category ${label}`);
    assert.match(f.target.textContent, /正文/); assert.match(f.target.textContent, /API/);
    assert.match(f.target.textContent, /能力/); assert.match(f.target.textContent, /世界书/);
    button(f.target, '确认备份并清空').click(); await tick();
    assert.equal(f.calls.reset, 1); assert.deepEqual(f.ctx, before);
    assert.ok(f.messages.some(([text, state]) => text === '已备份并清空。' && state !== 'error'));
    const after = descendants(f.target).find(item => item.tagName === 'BUTTON' && item.textContent === '确认备份并清空');
    assert.ok(!after || !visible(after));
  } finally { f.dispose(); }
});

for (const change of ['variables', 'rules', 'chat', 'body', 'candidate']) {
  test(`reset confirmation is refused when ${change} changes after review`, async () => {
    const f = fixture({ current: true });
    try {
      await tick(); button(f.target, '备份并清空当前变量').click(); await tick();
      if (change === 'variables') f.ctx.chatMetadata.variables.状态栏 = '{"name":"changed"}';
      if (change === 'rules') f.ctx.chatMetadata.LWB_RULES_V2.状态栏.type = 'string';
      if (change === 'chat') f.switchChat();
      if (change === 'body') f.ctx.chat[0].mes = f.ctx.chat[0].swipes[0] = 'changed prose';
      if (change === 'candidate') { f.ctx.chat[0].swipe_id = 1; f.ctx.chat[0].mes = 'other prose'; }
      button(f.target, '确认备份并清空').click(); await tick();
      assert.equal(f.calls.reset, 0);
      assert.ok(f.messages.some(([, state]) => state === 'error'));
    } finally { f.dispose(); }
  });
}

test('cancel and disposal invalidate the destructive confirmation', async () => {
  const f = fixture();
  try {
    await tick(); button(f.target, '备份并清空当前变量').click(); await tick();
    const confirm = button(f.target, '确认备份并清空');
    button(f.target, '取消清空').click(); await tick(); confirm.click(); await tick();
    assert.equal(f.calls.reset, 0);
    button(f.target, '备份并清空当前变量').click(); await tick();
    const pending = button(f.target, '确认备份并清空');
    f.view.dispose(); pending.click(); await tick(); assert.equal(f.calls.reset, 0);
  } finally { f.dispose(); }
});

test('failed reset is an error and never reports a successful clear', async () => {
  const f = fixture({ overrides: { resetCurrentStory: async () => { throw Error('backup write failed'); } } });
  try {
    await tick(); button(f.target, '备份并清空当前变量').click(); await tick();
    button(f.target, '确认备份并清空').click(); await tick();
    assert.ok(f.messages.some(([text, state]) => text === 'backup write failed' && state === 'error'));
    assert.ok(!f.messages.some(([text, state]) => /已.*清空/.test(text) && state !== 'error'));
  } finally { f.dispose(); }
});

test('current-only mode disables obsolete floor and Swipe management', async () => {
  const f = fixture({ current: true });
  try {
    await tick();
    for (const label of ['检查楼层与 Swipe 存档', '用原聊天校验 Swipe 标识', '重试恢复当前分支']) {
      const item = button(f.target, label); assert.ok(item.disabled || !visible(item), `${label} should not remain active`);
    }
    assert.match(f.target.textContent, /最近.*5|5.*备份|最多.*5/);
    assert.equal(f.calls.legacyRestore, 0);
  } finally { f.dispose(); }
});

test('backup list is inspected on demand and restores the explicitly selected backup', async () => {
  const f = fixture({ current: true });
  try {
    await tick(); assert.equal(f.calls.inspect, 0);
    button(f.target, '查看最近备份').click(); await tick(); assert.equal(f.calls.inspect, 1);
    assert.match(f.target.textContent, /first backup/); assert.match(f.target.textContent, /second backup/);
    const select = descendants(f.target).find(item => item.tagName === 'SELECT' && item.children.some(child => /first backup/.test(child.textContent)));
    assert.ok(select, 'backup selection should be rendered');
    select.value = '1'; select.onchange?.();
    button(f.target, '恢复所选备份').click(); await tick();
    assert.deepEqual(f.calls.restore, [[1, { expectedHash: 'sha256:second' }]]); assert.equal(f.calls.legacyRestore, 0);
  } finally { f.dispose(); }
});

test('backup restoration refuses a selection captured from another chat', async () => {
  const f = fixture({ current: true });
  try {
    await tick(); button(f.target, '查看最近备份').click(); await tick();
    const restore = button(f.target, '恢复所选备份'); f.switchChat(); restore.click(); await tick();
    assert.deepEqual(f.calls.restore, []); assert.ok(f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('backup restoration refuses stale preview when current variables were edited', async () => {
  const f = fixture({ current: true });
  try {
    await tick(); button(f.target, '查看最近备份').click(); await tick();
    f.ctx.chatMetadata.variables.状态栏 = '{"name":"new value"}';
    button(f.target, '恢复所选备份').click(); await tick();
    assert.deepEqual(f.calls.restore, []);
    assert.ok(f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('backup inspection discards results if the chat switches during loading', async () => {
  let resolve;
  const f = fixture({ current: true, overrides: { inspectCurrentStoryBackups: () => new Promise(done => { resolve = done; }) } });
  try {
    await tick(); button(f.target, '查看最近备份').click(); assert.equal(typeof resolve, 'function');
    f.switchChat(); resolve({ backups: [{ index: 0, at: 0, label: 'wrong chat backup', hash: 'x' }] }); await tick();
    assert.doesNotMatch(f.target.textContent, /wrong chat backup/);
    assert.deepEqual(f.calls.restore, []);
  } finally { f.dispose(); }
});

test('current-only backup import remains available when native restoration is blocked and does not restore automatically', async () => {
  const f = fixture({ current: true, blocked: true });
  try {
    await tick(); const action = button(f.target, '导入变量备份'); assert.equal(action.disabled, false);
    action.click();
    const input = descendants(f.target).find(item => item.tagName === 'INPUT' && item.type === 'file' && item.accept === '.json,application/json');
    assert.ok(input); input.files = [{ text: async () => '{"version":3,"mode":"current-only"}' }]; input.onchange(); await tick();
    assert.deepEqual(f.calls.imports, [{ version: 3, mode: 'current-only' }]);
    assert.equal(f.calls.legacyRestore, 0);
    assert.ok(f.messages.some(([text, state]) => text === '变量备份已导入。' && state !== 'error'));
  } finally { f.dispose(); }
});

test('current-only reload is explicit and does not inspect the old Swipe index', async () => {
  const f = fixture({ current: true });
  try {
    await tick(); button(f.target, '重新载入当前变量').click(); await tick();
    assert.equal(f.calls.legacyRestore, 1); assert.equal(f.calls.reset, 0);
    assert.deepEqual(f.calls.switch, []);
    assert.ok(!f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('current-only import refuses a file read for a chat that has since switched', async () => {
  let resolve; const f = fixture({ current: true });
  try {
    await tick(); button(f.target, '导入变量备份').click();
    const input = descendants(f.target).find(item => item.tagName === 'INPUT' && item.type === 'file' && item.accept === '.json,application/json');
    input.files = [{ text: () => new Promise(done => { resolve = done; }) }]; input.onchange();
    f.switchChat(); resolve('{"version":3}'); await tick();
    assert.deepEqual(f.calls.imports, []);
    assert.ok(f.messages.some(([, state]) => state === 'error'));
  } finally { f.dispose(); }
});

test('busy reset prevents duplicate submits and other mutations', async () => {
  let resolve; const f = fixture({ overrides: { resetCurrentStory: () => new Promise(done => { resolve = done; }) } });
  try {
    await tick(); button(f.target, '备份并清空当前变量').click(); await tick();
    button(f.target, '确认备份并清空').click(); assert.equal(typeof resolve, 'function');
    assert.equal(button(f.target, '改用简洁存储（保留当前变量）').disabled, true);
    assert.equal(button(f.target, '备份并清空当前变量').disabled, true);
    button(f.target, '改用简洁存储（保留当前变量）').click(); assert.deepEqual(f.calls.switch, []);
    resolve({ message: '已备份并清空。' }); await tick();
  } finally { f.dispose(); }
});
