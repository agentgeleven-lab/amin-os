import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStoryLibrary } from '../settings/story-library-view.js';

class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.style = {}; }
    append(...items) { this.children.push(...items); }
    remove() { this.removed = true; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
}
const all = node => [node, ...node.children.flatMap(all)];
const button = (root, label) => all(root).find(node => node.tagName === 'button' && node.textContent === label);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(runtime) {
    const root = new Element('main');
    const document = { createElement: tag => new Element(tag), body: new Element('body') };
    const errors = [];
    const view = mountStoryLibrary(root, { document, getRuntime: () => runtime, report: message => errors.push(message) });
    return { root, view, errors };
}
const report = extra => ({ complete: true, summary: { files: 3, bytes: 1200, referencedFiles: 2, referencedBytes: 1000, sharedFiles: 1, sharedBytes: 500, chatDocumentBytes: 4096, backupDocumentBytes: 8192 },
    duplicatePolicy: '内容寻址已复用文件，不会自动合并逻辑相似记录。',
    chats: [{ id: 'a', label: 'main', kind: 'chat', files: 2, bytes: 1000, exclusiveBytes: 500, sharedBytes: 500, documentBytes: 4096 },
        { id: 'b', label: 'backup', kind: 'backup', files: 1, bytes: 500, exclusiveBytes: 0, sharedBytes: 500, documentBytes: 8192 }],
    candidates: [{ id: 'unreferenced-a', bytes: 200 }], issues: [], ...extra });

test('library is demand-only, separates shared source estimates and requires explicit candidate preview', async () => {
    let calls = 0;
    const { root, view } = fixture({ scanStoryLibrary: async ({ onProgress }) => {
        calls++; onProgress({ phase: 'files', completed: 2, total: 3 }); return report();
    } });
    assert.equal(calls, 0);
    button(root, '扫描全库剧情文件').onclick(); await tick();
    assert.equal(calls, 1); assert.match(root.textContent, /聊天与分支（1）/); assert.match(root.textContent, /备份引用（1）/);
    assert.match(root.textContent, /独占 500 B · 共享 500 B/);
    assert.match(root.textContent, /聊天 4.00 KiB · 备份（已解压）8.00 KiB/);
    assert.match(root.textContent, /宿主备份文档（已解压）：8.00 KiB/);
    assert.match(root.textContent, /与上方外置依赖独立统计/);
    assert.match(root.textContent, /内容寻址已复用文件/);
    assert.doesNotMatch(root.textContent, /unreferenced-a/);
    button(root, '预览候选文件').onclick(); assert.match(root.textContent, /unreferenced-a/);
    assert.match(root.textContent, /永久删除不可用/);
    assert.equal(all(root).some(node => node.tagName === 'button' && /删除/.test(node.textContent)), false);
    assert.ok(all(root).every(node => node.style.overflowWrap === 'anywhere' || node === root));
    view.dispose();
});

test('partial scan lists observed candidates separately from deletion eligibility; backup errors cannot imply cleanup', async () => {
    let exports = 0;
    const snapshot = report({ complete: false, candidates: [], observedUnreferenced: [{ id: '<script>observed</script>', bytes: 100 }],
        cleanupBlockedReason: '备份不可读取', issues: [{ id: 'backup-a', message: '读取失败' }] });
    const { root, errors, view } = fixture({ scanStoryLibrary: async () => snapshot, exportStoryLibraryCandidates: async value => {
        exports++; assert.equal(value, snapshot); throw Error('引用已变化，请重新扫描');
    } });
    button(root, '扫描全库剧情文件').onclick(); await tick();
    assert.match(root.textContent, /扫描不完整/); assert.match(root.textContent, /备份不可读取/);
    button(root, '预览候选文件').onclick();
    assert.match(root.textContent, /<script>observed<\/script>/);
    assert.equal(all(root).some(node => node.tagName === 'script'), false);
    button(root, '重新核验并导出候选备份').onclick(); await tick();
    assert.equal(exports, 1); assert.match(root.textContent, /引用已变化/); assert.equal(errors.length, 1);
    assert.match(root.textContent, /未修改文件/); view.dispose();
});

test('candidate list pages and bounds long library rows', async () => {
    const { root, view } = fixture({ scanStoryLibrary: async () => report({ candidates: Array.from({ length: 26 }, (_, i) => ({ id: `candidate-${i}`, bytes: 2 })) }) });
    button(root, '扫描全库剧情文件').onclick(); await tick();
    button(root, '预览候选文件').onclick();
    assert.match(root.textContent, /candidate-24/); assert.doesNotMatch(root.textContent, /candidate-25/);
    button(root, '下一页').onclick(); assert.match(root.textContent, /candidate-25/); assert.doesNotMatch(root.textContent, /candidate-24/);
    view.dispose();
});

test('cancel and dispose invalidate late results and progress even when host ignores abort', async () => {
    let resolve, pending;
    const { root, view } = fixture({ scanStoryLibrary: options => { pending = options; return new Promise(done => { resolve = done; }); } });
    button(root, '扫描全库剧情文件').onclick();
    assert.equal(button(root, '扫描全库剧情文件').disabled, true);
    button(root, '取消扫描').onclick(); assert.equal(pending.signal.aborted, true);
    pending.onProgress({ phase: 'done', completed: 9, total: 9 }); resolve(report()); await tick();
    assert.match(root.textContent, /操作已取消/); assert.doesNotMatch(root.textContent, /已扫描外置文件/);
    button(root, '扫描全库剧情文件').onclick(); view.dispose();
    assert.equal(pending.signal.aborted, true); resolve(report()); await tick();
    assert.doesNotMatch(root.textContent, /已扫描外置文件/);
});
