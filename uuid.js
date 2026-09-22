/** Create a UUID without requiring the secure-context-only randomUUID API. */
export function uuid(cryptoSource = globalThis.crypto) {
    if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
    if (typeof cryptoSource?.getRandomValues !== 'function') throw Error('当前环境缺少安全随机数接口，无法生成标识。');
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
