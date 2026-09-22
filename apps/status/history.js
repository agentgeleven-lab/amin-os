import { uuid } from '../../uuid.js';
// History lives in chat metadata, never in the model-facing variable namespace.
export const HISTORY_KEY = 'world_status_hud_history_v1';
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
export function createHistory({ context, read, write, changed = () => {}, beforeRestore = () => {}, warn = () => {}, historyKey = HISTORY_KEY, messageKey = 'wsh_message_id', allowGroups = false }) {
  let metadata, chatId, previous = [], lastValue, blocked = false;
  const listeners = new Set();
  const emit = () => { changed(); for (const fn of listeners) fn(); };
  function messages() {
    let assigned = false;
    const result = (context().chat || []).map(m => {
      m.extra ||= {};
      if (!m.extra[messageKey]) { m.extra[messageKey] = uuid(); assigned = true; }
      return { id: m.extra[messageKey], variant: String(m.swipe_id ?? 0), message: m };
    });
    if (assigned) Promise.resolve(context().saveChat?.()).catch(e => warn('楼层标识保存失败：' + e.message));
    return result;
  }
  const key = m => m.id + ':' + m.variant;
  function save() { Promise.resolve(context().saveMetadata()).catch(e => warn('楼层记录保存失败：' + e.message)); }
  function sync() {
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
  return { sync, list, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
