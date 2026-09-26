// TT 2.3.0 public route adapter. No private filesystem access or write calls.
// Backup download decodes zstd in the host; normal chat/get loads all swipes.
function referenceExtra(extra) {
  return extra && Object.hasOwn(extra, 'amin_story_v2') ? { amin_story_v2: extra.amin_story_v2 } : {};
}

export function createStoryLibraryHost({ getHostWindow = () => globalThis.window,
  getContext = () => getHostWindow()?.SillyTavern?.getContext?.(), fetchImpl,
  limits = {},
} = {}) {
  const cap = { maxEntries: 10000, maxResponseBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024, timeoutMs: 30000, ...limits };
  function capabilities() {
    return { supported: !!getHostWindow()?.__TAURITAVERN__, maintenanceLock: false,
      globalDiskCoverage: false, scope: 'registered-chats-and-backups',
      reason: '宿主公开接口无法证明覆盖遗留聊天目录，也未提供阻止聊天写入和同步的全局维护锁。' };
  }
  async function census({ signal, onProgress = () => {} } = {}) {
    const entries = [], issues = [], descriptors = [], hashes = [];
    let bytes = 0, requests = 0;
    const check = () => { if (signal?.aborted) throw new Error('扫描已取消'); };
    const issue = (code, message) => issues.push({ code, message });
    const fail = message => { throw new Error(message); };
    const array = value => Array.isArray(value) ? value : fail('宿主返回了非数组目录');
    const name = value => typeof value === 'string' && value.trim() ? value : fail('宿主目录缺少文件标识');
    async function request(path, body) {
      check();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, cap.timeoutMs);
      let reader;
      try {
        const host = getHostWindow();
        const fetcher = fetchImpl || host?.fetch?.bind(host);
        if (!fetcher) fail('宿主请求接口不可用');
        const response = await fetcher(path, { method: 'POST', headers: {
          ...getContext()?.getRequestHeaders?.(), 'Content-Type': 'application/json',
        }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) fail(`读取失败 HTTP ${response.status}`);
        if (!response.body?.getReader) fail('宿主不支持有界流式读取');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '', size = 0;
        while (true) {
          check();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength; bytes += next.value.byteLength;
          if (size > cap.maxResponseBytes || bytes > cap.maxTotalBytes) fail('扫描读取量超过上限，请缩小数据量后重试');
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
        requests++;
        onProgress({ phase: 'reading', entries: entries.length, requests, bytes });
        return text;
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (reader) { try { await reader.cancel(); } catch { /* already closed */ } reader.releaseLock(); }
      }
    }
    const json = async (path, body) => JSON.parse(await request(path, body));
    async function hash(text) {
      const crypto = getHostWindow()?.crypto || globalThis.crypto;
      if (!crypto?.subtle) fail('宿主缺少 SHA-256 支持');
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join('');
    }
    function add(value) {
      if (descriptors.length >= cap.maxEntries) fail('目录条目数量超过扫描上限');
      if (descriptors.some(item => item.id === value.id)) fail('宿主目录含重复文件标识');
      descriptors.push(value);
    }
    try {
      if (!capabilities().supported) fail('仅支持 TauriTavern 文件存储宿主');
      const characters = array(await json('/api/characters/all', {}));
      for (const character of characters) {
        check();
        const avatar = name(character.avatar);
        const chats = array(await json('/api/characters/chats', { avatar_url: avatar, simple: true }));
        for (const chat of chats) {
          const file = name(chat.file_name);
          add({ id: JSON.stringify(['character', avatar, file]), kind: 'chat', label: `${character.name || avatar} / ${file}`,
            path: '/api/chats/get', body: { avatar_url: avatar, file_name: file, allow_not_found: false } });
        }
      }
      for (const group of array(await json('/api/groups/all', {}))) {
        name(String(group.id ?? ''));
        for (const raw of array(group.chats)) {
          const id = name(raw);
          // Multiple groups can point at the same physical chat.
          if (descriptors.some(item => item.id === JSON.stringify(['group', id]))) continue;
          add({ id: JSON.stringify(['group', id]), kind: 'chat', label: `${group.name || group.id} / ${id}`,
            path: '/api/chats/group/get', body: { id, allow_not_found: false } });
        }
      }
      for (const backup of array(await json('/api/backups/chat/get', { detail: 'catalog' }))) {
        const file = name(backup.file_name);
        add({ id: JSON.stringify(['backup', file]), kind: 'backup', label: file,
          path: '/api/backups/chat/download', body: { name: file } });
      }
      for (const descriptor of descriptors) {
        check();
        try {
          const text = await request(descriptor.path, descriptor.body);
          let payload;
          if (descriptor.kind === 'backup') {
            payload = [];
            const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
              if (index % 128 === 0) { check(); await new Promise(resolve => setTimeout(resolve, 0)); }
              if (lines[index].trim()) payload.push(JSON.parse(lines[index]));
            }
          } else payload = JSON.parse(text);
          array(payload);
          if (!payload.length || payload.some(row => !row || typeof row !== 'object' || Array.isArray(row))) fail('聊天记录不完整');
          if (payload.some(row => row.tt_swipe_cold)) fail('聊天仍含未加载的 Swipe');
          const header = payload[0];
          if (!header.chat_metadata || typeof header.chat_metadata !== 'object' || Array.isArray(header.chat_metadata)) fail('聊天缺少有效元数据头');
          // Retain only the census reference projection between documents.
          // Text, variables and full swipe bodies must not accumulate in memory.
          const chat = [];
          for (let index = 1; index < payload.length; index++) {
            if (index % 128 === 0) { check(); await new Promise(resolve => setTimeout(resolve, 0)); }
            const message = payload[index];
            if (message.swipes !== undefined && (!Array.isArray(message.swipes) || message.swipes.some(item => typeof item !== 'string'))) fail('回复候选记录不完整');
            if (message.swipe_info !== undefined && !Array.isArray(message.swipe_info)) fail('回复候选元数据不完整');
            chat.push({ extra: referenceExtra(message.extra),
              ...(message.swipe_info !== undefined ? { swipe_info: message.swipe_info.map(info => info == null ? null : { extra: referenceExtra(info.extra) }) } : {}),
            });
          }
          hashes.push([descriptor.id, await hash(text)]);
          // Logical response bytes (backup downloads are already decompressed),
          // not the on-disk compressed size nor the external Amin dependency size.
          const documentBytes = new TextEncoder().encode(text).byteLength;
          const chatMetadata = Object.hasOwn(header.chat_metadata, 'amin_os_story_storage_v2')
            ? { amin_os_story_storage_v2: header.chat_metadata.amin_os_story_storage_v2 } : {};
          entries.push({ id: descriptor.id, label: descriptor.label, kind: descriptor.kind, documentBytes, chatMetadata, chat });
        } catch (error) {
          issue('ENTRY_READ_FAILED', `${descriptor.label}: ${error.message}`);
          if (signal?.aborted || bytes > cap.maxTotalBytes) break;
        }
      }
    } catch (error) { issue(signal?.aborted ? 'CANCELLED' : 'CENSUS_FAILED', error.message); }
    let fingerprint = '';
    try { fingerprint = await hash(JSON.stringify(hashes.sort((a, b) => a[0].localeCompare(b[0])))); }
    catch (error) { issue('FINGERPRINT_FAILED', error.message); }
    return { complete: issues.length === 0, entries, issues, fingerprint, bytes,
      capabilities: capabilities(), scope: 'registered-chats-and-backups', projection: 'amin-story-references' };
  }
  return { census, capabilities };
}
