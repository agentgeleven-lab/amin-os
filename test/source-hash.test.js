import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {sha256Hex} from '../apps/tts/source-hash.js';

const expected = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fallback = value => sha256Hex(value, {});

test('pure JavaScript SHA-256 matches standard text vectors',async()=>{
    const vectors = [
        ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
        ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ];
    for (const [value, digest] of vectors) assert.equal(await fallback(value), digest);
});

test('fallback hashes TextEncoder Unicode and SHA-256 block boundaries exactly',async()=>{
    assert.equal(await fallback('你好，Amin OS 🌙'),'4bc37a4b1db48811ba6c09cf116848d68eb5ffcd16c41226af2c79c4a5a37de6');
    assert.equal(await fallback('\uD800'),'83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097');
    for (const value of ['剧情🐉カナe\u0301', ...[55,56,63,64,65,119,120,127,128,129].map(length=>'x'.repeat(length))]) {
        assert.equal(await fallback(value), expected(value));
    }
});

test('fallback matches node crypto for multiple random byte-safe texts',async()=>{
    for (let index=0; index<24; index++) {
        const value=randomBytes(index * 11 + 1).toString('base64url');
        assert.equal(await fallback(value), expected(value));
    }
});

test('WebCrypto is preferred and a rejected digest falls back locally',async()=>{
    let calls=0;
    const webCrypto={subtle:{async digest(algorithm, bytes){calls++;assert.equal(algorithm,'SHA-256');return createHash('sha256').update(bytes).digest();}}};
    assert.equal(await sha256Hex('web crypto',webCrypto),expected('web crypto'));
    assert.equal(calls,1);
    assert.equal(await sha256Hex('fallback after rejection',{subtle:{async digest(){throw Error('unavailable');}}}),expected('fallback after rejection'));
});
