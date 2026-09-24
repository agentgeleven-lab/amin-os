// Ephemeral change detection for background observers. Persisted history and
// transaction evidence still use their existing exact message paths.
const histories = new WeakMap();
const empty = [];
let sequence = 0;
export function chatRevision(chat = empty) {
    if (!Array.isArray(chat)) throw Error('聊天消息格式不兼容。');
    let previous = histories.get(chat);
    if (!previous) { previous = { rows: [], revision: ++sequence }; histories.set(chat, previous); }
    let changed = previous.rows.length !== chat.length;
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('聊天消息格式不兼容。');
        const name = message.name ?? '', user = !!message.is_user, text = message.mes ?? '', swipe = message.swipe_id ?? 0;
        const row = previous.rows[index];
        if (!row || row[0] !== name || row[1] !== user || row[2] !== text || row[3] !== swipe) {
            previous.rows[index] = [name, user, text, swipe]; changed = true;
        }
    }
    previous.rows.length = chat.length;
    if (changed) previous.revision = ++sequence;
    return previous.revision;
}
