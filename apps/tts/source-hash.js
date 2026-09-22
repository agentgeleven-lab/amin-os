const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');

function fallbackDigest(bytes) {
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const padding = new DataView(padded.buffer);
    padding.setUint32(paddedLength - 8, Math.floor(bytes.length / 0x20000000));
    padding.setUint32(paddedLength - 4, (bytes.length << 3) >>> 0);

    const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index++) words[index] = padding.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index++) {
            const a = words[index - 15], b = words[index - 2];
            const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
            const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a,b,c,d,e,f,g,h] = state;
        for (let index = 0; index < 64; index++) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const first = (h + sum1 + choose + K[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const second = (sum0 + majority) >>> 0;
            h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
        }
        for (const [index, value] of [a,b,c,d,e,f,g,h].entries()) state[index] = (state[index] + value) >>> 0;
    }
    const result = new Uint8Array(32), view = new DataView(result.buffer);
    state.forEach((value, index) => view.setUint32(index * 4, value));
    return result;
}

/** SHA-256 for stable text identity. WebCrypto is preferred but is unavailable on insecure LAN origins. */
export async function sha256Hex(text, cryptoSource = globalThis.crypto) {
    const bytes = new TextEncoder().encode(String(text));
    if (typeof cryptoSource?.subtle?.digest === 'function') {
        try {
            const digest = new Uint8Array(await cryptoSource.subtle.digest('SHA-256', bytes));
            if (digest.length === 32) return hex(digest);
        } catch { /* Use the local implementation without modifying browser globals. */ }
    }
    return hex(fallbackDigest(bytes));
}
