import { describe, expect, it } from 'vitest';
import { ClientActionSchema, formatAuthToken, parseAuthToken } from '../src';

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

  it.each([
    ['unknown action', { action: 'delete', to: deviceId }],
    ['device id of the wrong length', { action: 'send', to: 'short', ciphertext: 'abc' }],
    ['ciphertext that is not base64url', { action: 'send', to: deviceId, ciphertext: 'a b' }],
    ['empty ciphertext', { action: 'send', to: deviceId, ciphertext: '' }],
    ['oversized ciphertext', { action: 'send', to: deviceId, ciphertext: 'a'.repeat(16 * 1024 + 1) }],
    ['not an object', 'send'],
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
