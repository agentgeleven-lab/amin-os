import { readHistory } from './service.js';
/**
 * Only exact full blocks registered in this chat can be protected.
 * Similar-looking manually typed prose is left untouched.
 * Callers keep their normal chat identity and edited-draft guards.
 */
export function splitDiceDraft(text, ctx) {
    let body = String(text ?? '');
    const matches = readHistory(ctx).map(r => ({ id: r.id, text: r.text, offset: body.indexOf(r.text) })).filter(r => r.offset >= 0 && r.text).sort((a, b) => a.offset - b.offset);
    const blocks = [];
    for (const block of matches) {
        if (blocks.some(r => r.text === block.text)) continue;
        blocks.push({ id: block.id, text: block.text });
        body = body.split(block.text).join('');
    }
    if (blocks.length) body = body.replace(/\n+$/, '');
    return { body, blocks };
}
export function mergeDiceDraft(replacement, snapshot) {
    let body = String(replacement ?? '');
    const blocks = Array.isArray(snapshot?.blocks) ? snapshot.blocks : [];
    for (const block of blocks) if (typeof block.text === 'string' && block.text) body = body.split(block.text).join('');
    if (!blocks.length) return body;
    body = body.replace(/\n+$/, '');
    const fixed = blocks.map(r => r.text).filter(Boolean).join('\n\n');
    return body ? body + '\n' + fixed : fixed;
}
