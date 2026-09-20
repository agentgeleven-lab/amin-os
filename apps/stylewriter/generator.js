// Shared-AI adapter for stylewriter. Reuses the reply app's host-input helpers so both
// apps share the same protection rules for #send_textarea.
import { getAI } from '../../ai/service.js';
import { inputElement, waitForResult } from '../reply/generator.js';
import { normalizeResult } from './model.js';

export { inputElement, waitForResult };
export const APP_TASK = '文风转换';

export function sharedAI() { return getAI(); }

/** Pins channel + preset + limits at request time so later edits cannot affect a running job. */
export function captureSnapshot(service = getAI()) {
    if (!service) throw Error('文风转换依赖共享 AI 设置：请先在“AI 设置”中配置并启用渠道。');
    return service.capture('stylewriter');
}

/**
 * Runs the rewrite through the shared AI service. includeEffects stays off: style transfer
 * must not pull roleplay effect rules (or any other chat context) into the request.
 * `service` is injectable for tests; production always uses the shared singleton.
 */
export async function rewriteText(ctx, request, { signal, snapshot, service } = {}) {
    const ai = service ?? getAI();
    if (!ai) throw Error('文风转换依赖共享 AI 设置：请先在“AI 设置”中配置并启用渠道。');
    const captured = snapshot ?? ai.capture('stylewriter');
    const raw = await ai.generate(APP_TASK, ctx, request, { signal, snapshot: captured, includeEffects: false });
    return normalizeResult(raw);
}

/** Writes a draft into the host input with an input event only — never sends. */
export function writeToInput(node, text) {
    node.value = text;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.focus?.();
    try { node.setSelectionRange(text.length, text.length); } catch { /* non-text inputs */ }
}
