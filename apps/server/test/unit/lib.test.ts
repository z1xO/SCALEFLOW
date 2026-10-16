import { describe, expect, it } from 'vitest';
import { classifyError, PermanentJobError, RetryableJobError } from '../../src/handlers/types.js';
import { isBlockedAddress } from '../../src/handlers/network-guard.js';
import { parseLsn } from '../../src/infra/db/read-router.js';
import { SingleFlight, TimeoutError, withTimeout } from '../../src/lib/async.js';
import {
  canonicalJson,
  hashPassword,
  passwordNeedsRehash,
  sha256Hex,
  verifyPassword,
} from '../../src/lib/crypto.js';
import { isUuid, uuidv7, uuidv7Bound, uuidv7Timestamp } from '../../src/lib/uuid.js';

describe('uuidv7', () => {
  it('produces valid, version-7, RFC-variant UUIDs', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is strictly increasing within a process, even within one millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 5000 }, () => uuidv7(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays monotonic if the clock goes backwards', () => {
    const a = uuidv7(Date.now() + 5_000);
    const b = uuidv7(Date.now() - 60_000);
    expect(b > a).toBe(true);
  });

  it('encodes the timestamp and supports range bounds', () => {
    // A timestamp later than any id generated so far (the generator never goes backwards).
    const t = new Date(Date.now() + 86_400_000);
    const id = uuidv7(t.getTime());
    expect(uuidv7Timestamp(id).toISOString()).toBe(t.toISOString());
    expect(uuidv7Bound(t, 'min') <= id).toBe(true);
    expect(uuidv7Bound(t, 'max') >= id).toBe(true);
    expect(uuidv7Bound(new Date(t.getTime() + 1), 'min') > id).toBe(true);
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery staple', 12);
    expect(hash.startsWith('scrypt$12$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same', 10)).not.toBe(await hashPassword('same', 10));
  });

  it('flags hashes below the current cost for rehash', async () => {
    const hash = await hashPassword('pw', 10);
    expect(passwordNeedsRehash(hash, 12)).toBe(true);
    expect(passwordNeedsRehash(hash, 10)).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('is independent of key order and ignores undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null }, u: undefined })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(sha256Hex(canonicalJson({ b: 2, a: 1 })));
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])('blocks %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])('allows %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(false);
  });
});

describe('error classification', () => {
  it('maps handler errors to stored errors', () => {
    expect(classifyError(new PermanentJobError('bad_input', 'nope'), false)).toEqual({
      code: 'bad_input',
      message: 'nope',
      retryable: false,
    });
    expect(classifyError(new RetryableJobError('http_503', 'down'), false).retryable).toBe(true);
    expect(classifyError(new Error('boom'), false)).toEqual({ code: 'handler_error', message: 'boom', retryable: true });
    expect(classifyError(new PermanentJobError('x', 'y'), true).code).toBe('timeout');
    expect(classifyError(new Error('x'.repeat(5000)), false).message.length).toBeLessThan(1100);
  });
});

describe('async helpers', () => {
  it('withTimeout rejects slow promises', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, 'slow op')).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(5), 1000, 'fast op')).resolves.toBe(5);
  });

  it('SingleFlight coalesces concurrent calls', async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => sf.do('k', fn)));
    expect(results).toEqual(Array(10).fill(42));
    expect(calls).toBe(1);
    await sf.do('k', fn);
    expect(calls).toBe(2);
  });
});

describe('LSN parsing', () => {
  it('orders LSNs numerically', () => {
    const a = parseLsn('0/16B3748');
    const b = parseLsn('1/0');
    expect(a).not.toBeNull();
    expect(b! > a!).toBe(true);
    expect(parseLsn('16/B374D848')).toBe((0x16n << 32n) | 0xb374d848n);
    expect(parseLsn('garbage')).toBeNull();
  });
});
