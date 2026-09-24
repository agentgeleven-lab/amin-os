import { uuid } from '../../uuid.js';
import { acquireMetadataWrite, chatIdentity, createOperationService, metadataWriteStatus } from '../shared/operations.js';
import { isChatReady } from '../shared/chat-lifecycle.js';
import { markChatIdsDirty, saveChatMetadata } from '../shared/chat-save.js';
// History lives in chat metadata, never in the model-facing variable namespace.
export const HISTORY_KEY = 'world_status_hud_history_v1';
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const referenceSnapshot = m => JSON.stringify([m?.extra?.amin_story_v2 ?? null,
  m?.swipe_info?.[m.swipe_id ?? 0]?.extra?.amin_story_v2 ?? null]);
export function createHistory({ context, read, write, changed = () => {}, beforeRestore = () => {}, warn = () => {}, historyKey = HISTORY_KEY, messageKey = 'wsh_message_id', allowGroups = false,
  nativeState = () => ({ managed: false, ready: true }), externalRead = null }) {
  let metadata, chatId, previous = [], lastValue, blocked = false;
  let externalObserved = [];
  let queuedSave = null, pendingIds = null, saving = false, syncing = 0, suppressSaves = 0;
  const listeners = new Set();
  const saveGate = createOperationService(context);
  const offSaveGate = saveGate.subscribe(flushSave);
  const emit = () => { changed(); for (const fn of listeners) fn(); };
  const external = c => c?.chatMetadata?.amin_os_story_storage_v2?.version === 2;
  function syncExternal(c) {
    const switched = metadata !== c.chatMetadata || chatId !== c.getCurrentChatId();
    const observed = (c.chat || []).map(m => ({ message: m, variant: String(m.swipe_id ?? 0), name: m.name, content: m.mes,
      reference: referenceSnapshot(m) }));
    const dirty = switched || observed.length !== externalObserved.length || observed.some((m, i) =>
      m.message !== externalObserved[i]?.message || m.variant !== externalObserved[i]?.variant || m.content !== externalObserved[i]?.content ||
      m.name !== externalObserved[i]?.name || m.reference !== externalObserved[i]?.reference);
    metadata = c.chatMetadata; chatId = c.getCurrentChatId(); previous = [];
    lastValue = undefined; blocked = false; externalObserved = observed;
    queuedSave = null; pendingIds = null;
    // External state is authoritative. Merely opening or observing a floor never
    // allocates IDs, snapshots, or a metadata save in the chat file.
    if (dirty) emit();
  }
  function messages(beforeSave) {
    const c = context();
    let assigned = false;
    const result = (c.chat || []).map(m => {
      m.extra ||= {};
      if (!m.extra[messageKey]) { m.extra[messageKey] = uuid(); assigned = true; }
      return { id: m.extra[messageKey], variant: String(m.swipe_id ?? 0), message: m };
    });
    // External atomic operations update the observer before saveChat can emit a
    // synchronous host event and call sync again.
    beforeSave?.(result);
    // Newly observed chats are only cached in memory. Their history can be
    // rebuilt from the authoritative variables if the user switches away.
    if (assigned) {
      pendingIds = { metadata: c.chatMetadata, identity: chatIdentity(c) };
      markChatIdsDirty(c);
    }
    return result;
  }
  const key = m => m.id + ':' + m.variant;
  function queueSave(kind) {
    if (suppressSaves) return;
    const c = context();
    if (external(c)) return;
    if (!isChatReady(c)) return;
    const identity = chatIdentity(c);
    if (!queuedSave || queuedSave.metadata !== c.chatMetadata || queuedSave.identity !== identity) {
      queuedSave = { metadata: c.chatMetadata, identity, chat: false, metadataSave: false };
    }
    if (kind === 'chat') { queuedSave.chat = true; queuedSave.idsMark = pendingIds; }
    else queuedSave.metadataSave = true;
    saveGate.capture();
    flushSave();
  }
  function savePendingIds() {
    const c = context();
    if (pendingIds?.metadata === c.chatMetadata && pendingIds.identity === chatIdentity(c) && typeof c.saveChat === 'function') {
      queueSave('chat');
    }
  }
  function flushSave() {
    if (!queuedSave || saving || syncing) return;
    const c = context();
    if (external(c)) { queuedSave = null; pendingIds = null; return; }
    if (!isChatReady(c) || c?.chatMetadata !== queuedSave.metadata || chatIdentity(c) !== queuedSave.identity) return;
    const native = nativeState();
    if (native?.managed && !native.ready) return;
    const state = metadataWriteStatus(context);
    if (state.busy || state.dirty) return;
    let release;
    // Capturing a token can reconcile native variables and synchronously notify
    // this subscriber. Reserve our local guard before that work begins.
    saving = true;
    try { release = acquireMetadataWrite(context, saveGate.capture()); }
    catch (error) {
      saving = false;
      // A competing writer owns the lease; its completion will flush the queue.
      if (!['BUSY', 'DIRTY'].includes(error.code)) warn('楼层记录保存失败：' + error.message);
      return;
    }
    const pending = queuedSave;
    queuedSave = null;
    const finish = () => { saving = false; release(); flushSave(); };
    const stillCurrent = () => {
      const current = context();
      return !!current && isChatReady(current) && current.chatMetadata === pending.metadata && chatIdentity(current) === pending.identity;
    };
    const persist = async () => {
      if (!stillCurrent()) return;
      try {
        await saveChatMetadata(c);
        if (pending.chat && pendingIds === pending.idsMark) pendingIds = null;
      } catch (error) {
        warn((pending.chat ? '楼层标识保存失败：' : '楼层记录保存失败：') + error.message);
      }
    };
    persist().catch(error => warn('楼层记录保存失败：' + error.message)).finally(finish);
  }
  function save() { queueSave('metadata'); }
  function sync({ persist = true } = {}) {
    syncing++;
    if (!persist) suppressSaves++;
    try { syncCurrent(); }
    finally { syncing--; if (!persist) suppressSaves--; flushSave(); }
  }
  function syncCurrent() {
    const c = context();
    if (!isChatReady(c) || !c.chatMetadata || c.getCurrentChatId() == null || (c.groupId && !allowGroups)) return;
    if (external(c)) { syncExternal(c); return; }
    const native = nativeState();
    // LittleWhiteBox may still be replaying a copied branch. Recording now
    // would stamp a future value onto an older floor.
    if (native?.managed && !native.ready) return;
    const switched = metadata !== c.chatMetadata || chatId !== c.getCurrentChatId();
    if (switched) {
      metadata = c.chatMetadata; chatId = c.getCurrentChatId(); previous = [];
      lastValue = undefined; blocked = false; pendingIds = null;
      if (queuedSave && (queuedSave.metadata !== metadata || queuedSave.identity !== chatIdentity(c))) queuedSave = null;
    }
    const store = metadata[historyKey] ||= { records: {} };
    const now = messages();
    const tail = now.at(-1);
    const truncated = !switched && now.length < previous.length && now.every((m, i) => m.id === previous[i].id);
    const swipe = !switched && tail && previous.length === now.length && tail.id === previous.at(-1)?.id && tail.variant !== previous.at(-1)?.variant;
    if (!native?.managed && (truncated || swipe)) {
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
    if (native?.managed) blocked = false;
    if (blocked && value !== null) blocked = false;
    const recorded = tail && store.records[key(tail)];
    if (tail && !blocked && (!recorded || JSON.stringify(recorded.state) !== serialized)) {
      store.records[key(tail)] = { state: value, savedAt: Date.now() };
      if (!switched) save();
    }
    if (!switched && (moved || serialized !== lastValue)) savePendingIds();
    const dirty = moved || serialized !== lastValue || truncated || swipe || now.length !== previous.length;
    previous = now;
    lastValue = serialized;
    if (dirty) emit();
  }
  function list() {
    const c = context();
    if (metadata !== c.chatMetadata || chatId !== c.getCurrentChatId()) return [];
    if (external(c)) return (c.chat || []).map((m, index) => ({
      index, name: m.name || (m.is_user ? '用户' : '角色'), available: true, external: true,
    }));
    const records = metadata?.[historyKey]?.records || {};
    return (c.chat || []).map((m, index) => {
      const id = m.extra?.[messageKey];
      const record = records[id + ':' + String(m.swipe_id ?? 0)];
      return { index, name: m.name || (m.is_user ? '用户' : '角色'), available: !!record, state: copy(record?.state), savedAt: record?.savedAt };
    });
  }
  async function readFloor(index) {
    const c = context();
    if (!Number.isInteger(index) || index < 0 || index >= (c?.chat?.length ?? 0)) throw Error('楼层不存在。');
    const identity = chatIdentity(c), metadataAtStart = c.chatMetadata, message = c.chat[index], variant = String(message.swipe_id ?? 0), reference = referenceSnapshot(message), content = message.mes;
    if (external(c)) {
      if (typeof externalRead !== 'function') throw Error('外置楼层读取尚未就绪。');
      const state = await externalRead(index, c);
      const current = context();
      if (current?.chatMetadata !== metadataAtStart || chatIdentity(current) !== identity ||
          current.chat?.[index] !== message || String(message.swipe_id ?? 0) !== variant || referenceSnapshot(message) !== reference || message.mes !== content)
        throw Error('聊天或楼层已变化，请重新打开记录。');
      return { index, name: message.name || (message.is_user ? '用户' : '角色'), available: true, external: true, state: copy(state), variant, reference, content };
    }
    const row = list().find(row => row.index === index);
    if (!row?.available) throw Error('此楼层尚无记录。');
    return row;
  }
  function adoptExternal() {
    const c = context();
    if (!isChatReady(c) || !c.chatMetadata || c.getCurrentChatId() == null || (c.groupId && !allowGroups)) return false;
    if (external(c)) { syncExternal(c); return true; }
    const native = nativeState();
    if (native?.managed && !native.ready) return false;
    // Read before changing the observer. A malformed external value must not
    // silently replace an existing record or erase the previous observation.
    const value = copy(read()), serialized = JSON.stringify(value);
    const store = c.chatMetadata[historyKey] === undefined ? (c.chatMetadata[historyKey] = { records: {} }) : c.chatMetadata[historyKey];
    if (!store || typeof store !== 'object' || Array.isArray(store) || !store.records || typeof store.records !== 'object' || Array.isArray(store.records)) {
      throw Error('楼层历史资料格式无效，无法记录外部状态。');
    }
    messages(now => {
      const tail = now.at(-1);
      // A coordinated writer may already have included this exact history
      // snapshot in its atomic patches. Preserve its timestamp and metadata:
      // rewriting them during the applied notification invalidates its save token.
      if (tail && JSON.stringify(store.records[key(tail)]?.state) !== serialized) {
        store.records[key(tail)] = { ...store.records[key(tail)], state: value, savedAt: Date.now() };
      }
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
  return { sync, adoptExternal, list, readFloor, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, dispose() { queuedSave = null; offSaveGate(); saveGate.dispose(); listeners.clear(); } };
}
