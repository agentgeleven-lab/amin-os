// The embedded map keeps a live store and editable draft. Other apps read saved
// metadata, so travel must not silently bypass an unfinished map edit or save.
let runtime = null;
export function registerMapRuntime(value) {
    runtime = value;
    return () => { if (runtime === value) runtime = null; };
}
export function assertMapReady(ctx, { allowEmpty = false } = {}) {
    if (!runtime || runtime.context()?.chatMetadata !== ctx?.chatMetadata) return;
    runtime.persistence.ensureActive();
    if (runtime.persistence.saving()) throw Error('地图正在保存，请稍候再预览旅行。');
    if (runtime.persistence.suspended?.()) throw Error('当前聊天的联合操作正在保存或等待重试，请完成保存后再继续。');
    if (runtime.draft.status().dirty) throw Error('地图还有未保存的调整，请先保存或放弃地图草稿。');
    const saved = ctx.chatMetadata?.dynamicMapV1?.document;
    if (!saved && allowEmpty && ctx.chatMetadata?.dynamicMapV1 === undefined) return;
    if (!saved || JSON.stringify(runtime.store.snapshot()) !== JSON.stringify(saved)) throw Error('地图显示与已保存资料不同，请重新打开地图后再预览。');
}
