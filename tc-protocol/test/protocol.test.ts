import { describe, expect, it } from 'vitest';
import { ClientActionSchema, formatAuthToken, InitialsSchema, parseAuthToken } from '../src';

const deviceId = 'A'.repeat(43);
const sig = 'b'.repeat(86);

describe('ClientActionSchema', () => {
  it('accepts a send frame', () => {
    const frame = { action: 'send', to: deviceId, ciphertext: 'abc_-123' };
    expect(ClientActionSchema.parse(frame)).toEqual(frame);
  });

  it('accepts an ack frame', () => {
    expect(ClientActionSchema.safeParse({ action: 'ack', messageId: 'm1' }).success).toBe(true);
  });

  it('accepts an unsend frame, for one message or for all', () => {
    const one = { action: 'unsend', to: deviceId, messageId: 'm1' };
    const all = { action: 'unsend', to: deviceId };
    expect(ClientActionSchema.parse(one)).toEqual(one);
    expect(ClientActionSchema.parse(all)).toEqual(all);
  });

  it('accepts a fetch frame', () => {
    expect(ClientActionSchema.parse({ action: 'fetch' })).toEqual({ action: 'fetch' });
  });

  const tokenId = 'T'.repeat(43);
  const mac = 'M'.repeat(43);

  it('accepts an invite frame', () => {
    const frame = { action: 'invite', tokenId, initials: 'AZ' };
    expect(ClientActionSchema.parse(frame)).toEqual(frame);
  });

  it('accepts an accept frame', () => {
    const frame = { action: 'accept', tokenId, inviter: deviceId, initials: 'BB', mac };
    expect(ClientActionSchema.parse(frame)).toEqual(frame);
  });

  it.each([
    ['invite without initials', { action: 'invite', tokenId }],
    ['invite with bad initials', { action: 'invite', tokenId, initials: 'az' }],
    ['invite with a short token id', { action: 'invite', tokenId: 'abc', initials: 'AZ' }],
    ['accept without a MAC', { action: 'accept', tokenId, inviter: deviceId, initials: 'BB' }],
    ['accept with a bad inviter', { action: 'accept', tokenId, inviter: 'short', initials: 'BB', mac }],
    ['accept with bad initials', { action: 'accept', tokenId, inviter: deviceId, initials: 'B2', mac }],
  ])('rejects %s', (_label, frame) => {
    expect(ClientActionSchema.safeParse(frame).success).toBe(false);
  });

  it.each([
    ['unknown action', { action: 'delete', to: deviceId }],
    ['device id of the wrong length', { action: 'send', to: 'short', ciphertext: 'abc' }],
    ['ciphertext that is not base64url', { action: 'send', to: deviceId, ciphertext: 'a b' }],
    ['empty ciphertext', { action: 'send', to: deviceId, ciphertext: '' }],
    ['oversized ciphertext', { action: 'send', to: deviceId, ciphertext: 'a'.repeat(16 * 1024 + 1) }],
    ['not an object', 'send'],
    ['unsend without a receiver', { action: 'unsend', messageId: 'm1' }],
    ['unsend to a bad receiver', { action: 'unsend', to: 'short' }],
    ['unsend with an empty message id', { action: 'unsend', to: deviceId, messageId: '' }],
  ])('rejects %s', (_label, frame) => {
    expect(ClientActionSchema.safeParse(frame).success).toBe(false);
  });
});

describe('auth token', () => {
  it('round-trips', () => {
    const token = { deviceId, ts: 1_800_000_000, sig };
    expect(parseAuthToken(formatAuthToken(token))).toEqual(token);
  });

  it.each([
    ['two parts', `${deviceId}.123`],
    ['bad device id', `nope.123.${sig}`],
    ['non-numeric time', `${deviceId}.12a.${sig}`],
    ['short signature', `${deviceId}.123.abc`],
    ['empty', ''],
  ])('rejects %s', (_label, raw) => {
    expect(parseAuthToken(raw)).toBeUndefined();
  });
});

describe('initials', () => {
  it.each(['A', 'AZ', 'PC', 'ABCD'])('accepts %j', (initials) => {
    expect(InitialsSchema.parse(initials)).toBe(initials);
  });

  it.each([
    ['empty', ''],
    ['five letters', 'ABCDE'],
    ['lower case', 'az'],
    ['a digit, which would read as a label (D13)', 'PC2'],
    ['a space', 'A Z'],
    ['a letter outside A–Z', 'É'],
    ['a look-alike from another script', 'А'], // Cyrillic
  ])('rejects %s', (_label, initials) => {
    expect(InitialsSchema.safeParse(initials).success).toBe(false);
  });
});
