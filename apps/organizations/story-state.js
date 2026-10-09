import { registerModuleCodec } from '../story-state/access.js';
import { read, validate } from './model.js';

registerModuleCodec('organizations', {
  toLegacy(_ctx, snapshot) {
    if (snapshot == null) return {};
    return { variables: { 势力资料: JSON.stringify(validate(structuredClone(snapshot.doc))) },
      amin_os_organizations_v1: { locks: structuredClone(snapshot.locks ?? []), assessment: structuredClone(snapshot.assessment ?? null), backups: [] } };
  },
  fromLegacy(ctx) {
    const raw = ctx.chatMetadata?.variables?.势力资料;
    if (raw == null || raw === '') return null;
    const extra = ctx.chatMetadata.amin_os_organizations_v1 ?? {};
    return { version: 1, doc: read(raw), locks: structuredClone(extra.locks ?? []), assessment: structuredClone(extra.assessment ?? null) };
  },
});
