import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryStorage } from '../settings/story-storage-view.js';

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
  click() { this.onclick?.(); }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const button = (root, label) => {
  const result = descendants(root).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.ok(result, `missing button: ${label}`);
  return result;
};
const tick = () => new Promise(resolve => setImmediate(resolve));

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
