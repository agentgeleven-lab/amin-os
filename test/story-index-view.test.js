import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryStorage } from '../settings/story-storage-view.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; }
  append(...items) { this.children.push(...items); }
  remove() {}
  set textContent(text) { this.text = text; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
}
const all = node => [node, ...node.children.flatMap(all)];
const click = (root, label) => all(root).find(node => node.tagName === 'button' && node.textContent === label).onclick();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('storage browser scans only on demand, pages rows and clears stale chat display', async () => {
  globalThis.document = { createElement: tag => new Element(tag) };
  let ctx = { chatId: 'a', chat: [], chatMetadata: { integrity: 'a' } };
  globalThis.SillyTavern = { getContext: () => ctx };
  let scans = 0;
  const runtime = {
    storyStatus: () => ({ available: true, enabled: true }),
    inspectStoryIndex: async () => { scans++; return { indexed: true, inheritedFrom: { chat: 'parent-chat' },
      baseHealth: { readable: true }, states: 1, unreadableStates: 0, cleanupReason: '无法确认全局引用，未删除文件。',
      rows: Array.from({ length: 51 }, (_, floor) => ({ floor, swipe: 0, selected: true, role: 'assistant', stateId: 'state-a', readable: true })) }; },
  };
  const root = new Element('main'), view = mountStoryStorage(root, () => {}, () => runtime);
  await tick(); assert.equal(scans, 0);
  click(root, '检查楼层与 Swipe 存档'); await tick();
  assert.equal(scans, 1); assert.match(root.textContent, /parent-chat/);
  assert.match(root.textContent, /第 50 楼/); assert.doesNotMatch(root.textContent, /第 51 楼/);
  click(root, '下一页'); assert.match(root.textContent, /第 51 楼/); assert.doesNotMatch(root.textContent, /第 50 楼/);
  ctx = { chatId: 'b', chat: [], chatMetadata: { integrity: 'b' } };
  click(root, '刷新状态'); await tick();
  assert.doesNotMatch(root.textContent, /parent-chat/);
  view.dispose();
});
