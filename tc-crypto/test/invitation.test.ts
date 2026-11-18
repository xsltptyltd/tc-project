import { beforeAll, describe, expect, it } from 'vitest';
import {
  generateIdentity,
  init,
  invitationKey,
  invitationMac,
  invitationTokenId,
  isInvitationSecret,
  newInvitationSecret,
  verifyInvitationMac,
} from '../src';

beforeAll(() => init());

const alice = generateIdentity().deviceId;
const bob = generateIdentity().deviceId;
const mallory = generateIdentity().deviceId;

describe('an invitation secret', () => {
  it('is 32 random bytes, different every time', () => {
    const a = newInvitationSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newInvitationSecret()).not.toBe(a);
  });

  it('is recognised only in the exact form it is made in', () => {
    const secret = newInvitationSecret();
    expect(isInvitationSecret(secret)).toBe(true);
    expect(isInvitationSecret(secret.slice(0, -1))).toBe(false); // 31 bytes and a bit
    expect(isInvitationSecret('S'.repeat(43))).toBe(false); // stray bits after the 32 bytes
    expect(isInvitationSecret(`${secret}AA`)).toBe(false);
    expect(isInvitationSecret('*'.repeat(43))).toBe(false);
  });
});

describe('an invitation key', () => {
  it('is the same on both sides only with the same code and the same proximity value', () => {
    const secret = newInvitationSecret();
    expect(invitationKey(secret, 'room 1')).toBe(invitationKey(secret, 'room 1'));
    expect(invitationKey(secret, 'room 1')).not.toBe(invitationKey(secret, 'room 2'));
    expect(invitationKey(secret, 'room 1')).not.toBe(invitationKey(newInvitationSecret(), 'room 1'));
    expect(invitationKey(secret, 'room 1')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not contain the proximity value or the secret', () => {
    const secret = newInvitationSecret();
    const key = invitationKey(secret, 'kitchen');
    expect(key).not.toContain('kitchen');
    expect(key).not.toBe(secret);
  });

  it('needs a proximity value and a real secret', () => {
    expect(() => invitationKey(newInvitationSecret(), '')).toThrow('no proximity value');
    expect(() => invitationKey('abc', 'room 1')).toThrow('not an invitation secret');
  });

  it('gives a token id that is stable, differs per key, and is not the key', () => {
    const key = invitationKey(newInvitationSecret(), 'room 1');
    expect(invitationTokenId(key)).toBe(invitationTokenId(key));
    expect(invitationTokenId(key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitationTokenId(key)).not.toBe(key);
    expect(invitationTokenId(invitationKey(newInvitationSecret(), 'room 1'))).not.toBe(invitationTokenId(key));
  });

  it('cannot give a token id unless it is 32 bytes', () => {
    expect(() => invitationTokenId('abc')).toThrow('not an invitation key');
  });
});

describe('the invitee’s MAC', () => {
  const secret = newInvitationSecret();
  const key = invitationKey(secret, 'room 1');
  const mac = invitationMac(key, alice, bob, 'BB');

  it('is accepted with the same key and the same facts', () => {
    expect(verifyInvitationMac(key, alice, bob, 'BB', mac)).toBe(true);
  });

  it.each([
    ['another invitee — the backend swapping the key', () => verifyInvitationMac(key, alice, mallory, 'BB', mac)],
    ['other initials', () => verifyInvitationMac(key, alice, bob, 'MM', mac)],
    ['another inviter', () => verifyInvitationMac(key, mallory, bob, 'BB', mac)],
    [
      'another code — made without seeing it',
      () => verifyInvitationMac(invitationKey(newInvitationSecret(), 'room 1'), alice, bob, 'BB', mac),
    ],
    ['the same code from another room', () => verifyInvitationMac(invitationKey(secret, 'room 2'), alice, bob, 'BB', mac)],
    ['a MAC that is not base64url', () => verifyInvitationMac(key, alice, bob, 'BB', '!!!')],
    ['a MAC of the wrong length', () => verifyInvitationMac(key, alice, bob, 'BB', mac.slice(0, 40))],
  ])('is refused for %s', (_label, check) => {
    expect(check()).toBe(false);
  });
});
