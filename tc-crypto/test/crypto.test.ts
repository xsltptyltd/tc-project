import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceIdSchema, parseAuthToken } from 'tc-protocol';
import { createAuthToken, decryptFrom, encryptFor, generateIdentity, init } from '../src';

beforeAll(() => init());

describe('identity', () => {
  it('produces a valid device id, different each time', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(DeviceIdSchema.safeParse(a.deviceId).success).toBe(true);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it('creates a well-formed auth token', () => {
    const me = generateIdentity();
    const token = parseAuthToken(createAuthToken(me, 1_800_000_000));
    expect(token).toMatchObject({ deviceId: me.deviceId, ts: 1_800_000_000 });
  });
});

describe('encryption', () => {
  it('lets the receiver, and only the receiver, read a message', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    const ciphertext = encryptFor(alice, bob.deviceId, { v: 1, text: 'hello bob' });

    expect(ciphertext).not.toContain('hello');
    expect(decryptFrom(bob, alice.deviceId, ciphertext)).toEqual({ v: 1, text: 'hello bob' });
    expect(() => decryptFrom(eve, alice.deviceId, ciphertext)).toThrow();
  });

  it('rejects a message that claims the wrong sender', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const eve = generateIdentity();
    const forged = encryptFor(eve, bob.deviceId, { v: 1, text: 'it is alice, honest' });
    expect(() => decryptFrom(bob, alice.deviceId, forged)).toThrow();
  });

  it('rejects an altered message', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const ciphertext = encryptFor(alice, bob.deviceId, { v: 1, text: 'hello' });
    // change one character in the middle: every bit there is part of the message
    const at = Math.floor(ciphertext.length / 2);
    const swapped = ciphertext[at] === 'A' ? 'B' : 'A';
    const altered = ciphertext.slice(0, at) + swapped + ciphertext.slice(at + 1);
    expect(() => decryptFrom(bob, alice.deviceId, altered)).toThrow('could not be decrypted');
  });

  it('gives a different ciphertext each time', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const payload = { v: 1 as const, text: 'same' };
    expect(encryptFor(alice, bob.deviceId, payload)).not.toBe(encryptFor(alice, bob.deviceId, payload));
  });
});
