import { describe, expect, it } from 'vitest';
import { verifyAuthToken } from '../src/core/auth';
import { handler as authorizer } from '../src/handlers/authorizer';
import { authToken, newDevice } from './helpers';

const NOW = 1_800_000_000;

describe('verifyAuthToken', () => {
  it('accepts a token signed by the device it names', () => {
    const device = newDevice();
    expect(verifyAuthToken(authToken(device, NOW), NOW)).toEqual({ ok: true, deviceId: device.deviceId });
  });

  it('tolerates a small clock difference', () => {
    const device = newDevice();
    expect(verifyAuthToken(authToken(device, NOW - 60), NOW).ok).toBe(true);
    expect(verifyAuthToken(authToken(device, NOW + 60), NOW).ok).toBe(true);
  });

  it('rejects an old token', () => {
    const device = newDevice();
    expect(verifyAuthToken(authToken(device, NOW - 61), NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a device id the caller does not hold the key for', () => {
    const victim = newDevice();
    const attacker = newDevice();
    expect(verifyAuthToken(authToken(attacker, NOW, victim.deviceId), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each([undefined, '', 'not-a-token', 'a.b.c'])('rejects malformed input %j', (raw) => {
    expect(verifyAuthToken(raw, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('authorizer handler', () => {
  const event = (auth?: string) =>
    ({
      type: 'REQUEST',
      methodArn: 'arn:aws:execute-api:region:account:api/stage/$connect',
      queryStringParameters: auth === undefined ? null : { auth },
    }) as never;

  it('allows a valid token and names the device as principal', async () => {
    const device = newDevice();
    const result = await authorizer(event(authToken(device, Math.floor(Date.now() / 1000))));
    expect(result.principalId).toBe(device.deviceId);
    expect(result.policyDocument.Statement[0]).toMatchObject({ Effect: 'Allow' });
  });

  it('denies a missing token', async () => {
    const result = await authorizer(event());
    expect(result.policyDocument.Statement[0]).toMatchObject({ Effect: 'Deny' });
  });
});
