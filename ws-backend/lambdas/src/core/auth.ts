import { createPublicKey, verify } from 'node:crypto';
import {
  AUTH_MAX_SKEW_SECONDS,
  authSigningString,
  parseAuthToken,
  type DeviceId,
} from 'tc-protocol';

export type AuthResult =
  | { ok: true; deviceId: DeviceId }
  | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

// DER prefix that turns a raw 32-byte Ed25519 public key into an SPKI document.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Checks that the caller holds the private key behind the device id it claims.
 * A device id on its own proves nothing: every contact knows it.
 */
export function verifyAuthToken(raw: string | undefined, nowSeconds: number): AuthResult {
  const token = raw === undefined ? undefined : parseAuthToken(raw);
  if (!token) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - token.ts) > AUTH_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(token.deviceId, 'base64url')]),
      format: 'der',
      type: 'spki',
    });
    const valid = verify(
      null,
      Buffer.from(authSigningString(token.deviceId, token.ts)),
      key,
      Buffer.from(token.sig, 'base64url'),
    );
    return valid ? { ok: true, deviceId: token.deviceId } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}
