import { uuid } from '../../uuid.js';
import { acquireMetadataWrite, chatIdentity, createOperationService, metadataWriteStatus } from '../shared/operations.js';
// History lives in chat metadata, never in the model-facing variable namespace.
export const HISTORY_KEY = 'world_status_hud_history_v1';
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
export function createHistory({ context, read, write, changed = () => {}, beforeRestore = () => {}, warn = () => {}, historyKey = HISTORY_KEY, messageKey = 'wsh_message_id', allowGroups = false }) {
  let metadata, chatId, previous = [], lastValue, blocked = false;
  let queuedSave = null, saving = false, syncing = 0, suppressSaves = 0;
  const listeners = new Set();
  const saveGate = createOperationService(context);
  const offSaveGate = saveGate.subscribe(flushSave);
  const emit = () => { changed(); for (const fn of listeners) fn(); };
  function messages(beforeSave) {
    let assigned = false;
    const result = (context().chat || []).map(m => {
      m.extra ||= {};
      if (!m.extra[messageKey]) { m.extra[messageKey] = uuid(); assigned = true; }
      return { id: m.extra[messageKey], variant: String(m.swipe_id ?? 0), message: m };
    });
    // External atomic operations update the observer before saveChat can emit a
    // synchronous host event and call sync again.
    beforeSave?.(result);
    if (assigned) Promise.resolve(context().saveChat?.()).catch(e => warn('楼层标识保存失败：' + e.message));
    return result;
  }
  const key = m => m.id + ':' + m.variant;
  function flushSave() {
    if (!queuedSave || saving || syncing) return;
    const c = context();
    if (c?.chatMetadata !== queuedSave.metadata || chatIdentity(c) !== queuedSave.identity) return;
    const state = metadataWriteStatus(context);
    if (state.busy || state.dirty) return;
    let release;
    try { release = acquireMetadataWrite(context, saveGate.capture()); }
    catch (error) { warn('楼层记录保存失败：' + error.message); return; }
    queuedSave = null; saving = true;
    const finish = () => { saving = false; release(); flushSave(); };
    try {
      Promise.resolve(c.saveMetadata()).catch(error => warn('楼层记录保存失败：' + error.message)).finally(finish);
    } catch (error) { warn('楼层记录保存失败：' + error.message); finish(); }
  }
  function save() {
    if (suppressSaves) return;
    const c = context();
    queuedSave = { metadata: c.chatMetadata, identity: chatIdentity(c) };
    saveGate.capture();
    flushSave();
  }
  function sync({ persist = true } = {}) {
    syncing++;
    if (!persist) suppressSaves++;
    try { syncCurrent(); }
    finally { syncing--; if (!persist) suppressSaves--; flushSave(); }
  }
  function syncCurrent() {
    const c = context();
    if (!c.chatMetadata || c.getCurrentChatId() == null || (c.groupId && !allowGroups)) return;
    const switched = metadata !== c.chatMetadata || chatId !== c.getCurrentChatId();
    if (switched) { metadata = c.chatMetadata; chatId = c.getCurrentChatId(); previous = []; lastValue = undefined; blocked = false; }
    const store = metadata[historyKey] ||= { records: {} };
    const now = messages();
    const tail = now.at(-1);
    const truncated = !switched && now.length < previous.length && now.every((m, i) => m.id === previous[i].id);
    const swipe = !switched && tail && previous.length === now.length && tail.id === previous.at(-1)?.id && tail.variant !== previous.at(-1)?.variant;
    if (truncated || swipe) {
      beforeRestore();
      const record = tail && store.records[key(tail)];
      if (record) { write(copy(record.state)); blocked = false; }
      else if (swipe && now.length > 1 && store.records[key(now.at(-2))]) {
        write(copy(store.records[key(now.at(-2))].state)); blocked = false;
      } else {
        // No historical evidence: clear the future state instead of inventing a past value.
        write(null); blocked = true;
        warn('这个楼层没有状态记录，已清除当前状态，避免将未来数值送给模型。请按此处剧情重新生成。');
      }
      save();
    }
    let value;
    try { value = copy(read()); } catch { previous = now; return; }
    const serialized = JSON.stringify(value);
    const moved = switched || key(tail || {}) !== key(previous.at(-1) || {});
    if (blocked && value !== null) blocked = false;
    if (tail && !blocked && (moved || serialized !== lastValue)) {
      store.records[key(tail)] = { state: value, savedAt: Date.now() };
      save();
    }
    const dirty = moved || serialized !== lastValue || truncated || swipe || now.length !== previous.length;
    previous = now;
    lastValue = serialized;
    if (dirty) emit();
  }
  function list() {
    if (metadata !== context().chatMetadata || chatId !== context().getCurrentChatId()) return [];
    const records = metadata?.[historyKey]?.records || {};
    return (context().chat || []).map((m, index) => {
      const id = m.extra?.[messageKey];
      const record = records[id + ':' + String(m.swipe_id ?? 0)];
      return { index, name: m.name || (m.is_user ? '用户' : '角色'), available: !!record, state: copy(record?.state), savedAt: record?.savedAt };
    });
  }
  function adoptExternal() {
    const c = context();
    if (!c.chatMetadata || c.getCurrentChatId() == null || (c.groupId && !allowGroups)) return false;
    // Read before changing the observer. A malformed external value must not
    // silently replace an existing record or erase the previous observation.
    const value = copy(read()), serialized = JSON.stringify(value);
    const store = c.chatMetadata[historyKey] === undefined ? (c.chatMetadata[historyKey] = { records: {} }) : c.chatMetadata[historyKey];
    if (!store || typeof store !== 'object' || Array.isArray(store) || !store.records || typeof store.records !== 'object' || Array.isArray(store.records)) {
      throw Error('楼层历史资料格式无效，无法记录外部状态。');
    }
    messages(now => {
      const tail = now.at(-1);
      if (tail) store.records[key(tail)] = { ...store.records[key(tail)], state: value, savedAt: Date.now() };
      metadata = c.chatMetadata;
      chatId = c.getCurrentChatId();
      previous = now;
      lastValue = serialized;
      blocked = false;
    });
    // The shared operation that applied this state performs the one metadata
    // save. Never replay historical state or schedule another save here.
    emit();
    return true;
  }
  return { sync, adoptExternal, list, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() { queuedSave = null; offSaveGate(); saveGate.dispose(); listeners.clear(); } };
}
