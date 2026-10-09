import { registerModuleCodec } from '../story-state/access.js';
import { validateTemplate } from './state-tools.js';

registerModuleCodec('status', {
  toLegacy(_ctx, snapshot) {
    return snapshot == null ? {} : { variables: { 状态栏: JSON.stringify(validateTemplate(structuredClone(snapshot))) } };
  },
  fromLegacy(ctx) {
    const raw = ctx.chatMetadata?.variables?.状态栏;
    if (raw == null || raw === '') return null;
    return structuredClone(validateTemplate(typeof raw === 'string' ? JSON.parse(raw) : raw));
  },
});
