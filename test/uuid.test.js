import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {uuid} from '../uuid.js';

test('prefers native randomUUID and keeps its crypto receiver',()=>{
    const cryptoSource={randomUUID(){assert.equal(this,cryptoSource);return 'native-id';},getRandomValues(){throw Error('unexpected fallback');}};
    assert.equal(uuid(cryptoSource),'native-id');
});

test('HTTP fallback produces RFC 4122 version 4 and variant bits from exactly 16 random bytes',()=>{
    let calls=0;
    const cryptoSource={getRandomValues(bytes){assert.equal(this,cryptoSource);assert.ok(bytes instanceof Uint8Array);assert.equal(bytes.length,16);calls++;bytes.fill(255);return bytes;}};
    assert.equal(uuid(cryptoSource),'ffffffff-ffff-4fff-bfff-ffffffffffff');
    assert.equal(calls,1);
    assert.equal(uuid({getRandomValues:bytes=>bytes.fill(0)}),'00000000-0000-4000-8000-000000000000');
});

test('HTTP fallback generates distinct valid IDs using the cryptographic random source',()=>{
    const cryptoSource={getRandomValues:bytes=>webcrypto.getRandomValues(bytes)};
    const ids=Array.from({length:4096},()=>uuid(cryptoSource));
    assert.equal(new Set(ids).size,ids.length);
    for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('missing or failed cryptographic randomness fails explicitly instead of falling back to weak IDs',()=>{
    assert.throws(()=>uuid({}),/安全随机数/);
    assert.throws(()=>uuid(null),/安全随机数/);
    const failure=Error('random source failed');
    assert.throws(()=>uuid({getRandomValues(){throw failure;}}),error=>error===failure);
});
