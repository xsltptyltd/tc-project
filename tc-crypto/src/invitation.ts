// The secrets behind an invitation (design/DECISIONS.md D1, D18).
//
// The inviter makes a random secret and shows it, with its device id, as a code — text in
// a terminal, a QR code on a phone. The invitation's key mixes that secret with a
// proximity value the two devices share because they are side by side (a room in the
// terminal; later, a value the inviter advertises over Bluetooth). Nothing but the key's
// hash, the token id, ever reaches the backend: not the secret, not the proximity value.
// Someone with the code but not the proximity value computes another token id and finds
// nothing.
//
// The invitee proves it held the key with a MAC over who is inviting whom, which the
// inviter checks: so the backend, which relays the invitee's key, cannot swap it.
//
// The key and the MAC are HMAC-SHA-512-256, which is libsodium's `crypto_auth`; the token
// id is the first 32 bytes of SHA-512. test/libsodium-compat.test.ts checks all three.
import nacl from 'tweetnacl';
import type { DeviceId, Initials } from 'tc-protocol';
import { fromBase64Url, toBase64Url, utf8Encode } from './encoding';

/** Bytes of secret in an invitation: also the key length of libsodium's crypto_auth. */
export const INVITATION_SECRET_BYTES = 32;

const KEY_CONTEXT = 'tc-invite-key-v1:';
const TOKEN_ID_CONTEXT = utf8Encode('tc-invite-token-v1:');
const HMAC_BLOCK_BYTES = 128; // SHA-512
const OUTPUT_BYTES = 32;

/** A fresh one-time secret, base64url. It is shown to the invitee and to nobody else. */
export function newInvitationSecret(): string {
  return toBase64Url(nacl.randomBytes(INVITATION_SECRET_BYTES));
}

/** True for exactly what `newInvitationSecret` makes: 32 bytes, canonical base64url. */
export function isInvitationSecret(secret: string): boolean {
  try {
    return fromBase64Url(secret).length === INVITATION_SECRET_BYTES;
  } catch {
    return false;
  }
}

function secretBytes(secret: string): Uint8Array {
  const bytes = fromBase64Url(secret);
  if (bytes.length !== INVITATION_SECRET_BYTES) throw new Error('not an invitation secret');
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The invitation's key: the secret from the code, bound to the proximity value. Two
 * devices get the same key only if they read the same code and share the same value.
 */
export function invitationKey(secret: string, proximity: string): string {
  if (proximity.length === 0) throw new Error('no proximity value');
  return toBase64Url(hmacSha512256(secretBytes(secret), utf8Encode(KEY_CONTEXT + proximity)));
}

function keyBytes(key: string): Uint8Array {
  const bytes = fromBase64Url(key);
  if (bytes.length !== OUTPUT_BYTES) throw new Error('not an invitation key');
  return bytes;
}

/** What the backend knows the invitation by. Cannot be turned back into the key. */
export function invitationTokenId(key: string): string {
  return toBase64Url(nacl.hash(concat(TOKEN_ID_CONTEXT, keyBytes(key))).subarray(0, OUTPUT_BYTES));
}

/** HMAC-SHA-512 truncated to 32 bytes (RFC 2104; libsodium's crypto_auth). Key ≤ 128 bytes. */
function hmacSha512256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(HMAC_BLOCK_BYTES);
  block.set(key);
  const inner = block.map((b) => b ^ 0x36);
  const outer = block.map((b) => b ^ 0x5c);
  return nacl.hash(concat(outer, nacl.hash(concat(inner, message)))).subarray(0, OUTPUT_BYTES);
}

/** What the MAC covers: who invited, who accepted, and the initials the invitee gave. */
export function invitationMacString(inviter: DeviceId, invitee: DeviceId, initials: Initials): string {
  return `tc-invite-v1:${inviter}:${invitee}:${initials}`;
}

/** Made by the invitee, with the key from the code it read and the value it sensed. */
export function invitationMac(key: string, inviter: DeviceId, invitee: DeviceId, initials: Initials): string {
  return toBase64Url(hmacSha512256(keyBytes(key), utf8Encode(invitationMacString(inviter, invitee, initials))));
}

/** Checked by the inviter. False for anything that was not made with this key. */
export function verifyInvitationMac(
  key: string,
  inviter: DeviceId,
  invitee: DeviceId,
  initials: Initials,
  mac: string,
): boolean {
  let given: Uint8Array;
  try {
    given = fromBase64Url(mac);
  } catch {
    return false;
  }
  const expected = fromBase64Url(invitationMac(key, inviter, invitee, initials));
  return given.length === expected.length && nacl.verify(given, expected); // constant time
}
