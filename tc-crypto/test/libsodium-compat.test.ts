// Proves the wire formats are libsodium's, so a libsodium-based client could talk to
// this one. libsodium is a dev dependency only; nothing at runtime uses it.
import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import { authSigningString, parseAuthToken } from 'tc-protocol';
import {
  createAuthToken,
  decryptFrom,
  encryptFor,
  generateIdentity,
  init,
  invitationKey,
  invitationMac,
  invitationMacString,
  invitationTokenId,
  newInvitationSecret,
  type Identity,
} from '../src';

const variant = () => sodium.base64_variants.URLSAFE_NO_PADDING;
const b64 = (text: string) => sodium.from_base64(text, variant());

/** The libsodium view of one of our identities. */
function sodiumKeys(identity: Identity) {
  const pair = sodium.crypto_sign_seed_keypair(b64(identity.secretKey));
  return {
    signPublic: pair.publicKey,
    boxPublic: sodium.crypto_sign_ed25519_pk_to_curve25519(pair.publicKey),
    boxSecret: sodium.crypto_sign_ed25519_sk_to_curve25519(pair.privateKey),
  };
}

beforeAll(async () => {
  await init();
  await sodium.ready;
});

describe('compatibility with libsodium', () => {
  it('derives the same device id from a seed', () => {
    const me = generateIdentity();
    expect(sodium.to_base64(sodiumKeys(me).signPublic, variant())).toBe(me.deviceId);
  });

  it('produces signatures libsodium accepts', () => {
    const me = generateIdentity();
    const token = parseAuthToken(createAuthToken(me, 1_800_000_000))!;
    const ok = sodium.crypto_sign_verify_detached(
      b64(token.sig),
      authSigningString(me.deviceId, 1_800_000_000),
      sodiumKeys(me).signPublic,
    );
    expect(ok).toBe(true);
  });

  it('produces ciphertext libsodium can open', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const bytes = b64(encryptFor(alice, bob.deviceId, { v: 1, text: 'héllo 👋' }));
    const n = sodium.crypto_box_NONCEBYTES;
    const plain = sodium.crypto_box_open_easy(
      bytes.slice(n),
      bytes.slice(0, n),
      sodiumKeys(alice).boxPublic,
      sodiumKeys(bob).boxSecret,
    );
    expect(JSON.parse(sodium.to_string(plain))).toEqual({ v: 1, text: 'héllo 👋' });
  });

  it('opens ciphertext libsodium produced', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const box = sodium.crypto_box_easy(
      JSON.stringify({ v: 1, text: 'from libsodium' }),
      nonce,
      sodiumKeys(bob).boxPublic,
      sodiumKeys(alice).boxSecret,
    );
    const wire = new Uint8Array(nonce.length + box.length);
    wire.set(nonce);
    wire.set(box, nonce.length);
    expect(decryptFrom(bob, alice.deviceId, sodium.to_base64(wire, variant()))).toEqual({
      v: 1,
      text: 'from libsodium',
    });
  });

  it('derives invitation keys with libsodium crypto_auth, keyed by the secret', () => {
    const secret = newInvitationSecret();
    const theirs = sodium.crypto_auth('tc-invite-key-v1:room 1', b64(secret));
    expect(invitationKey(secret, 'room 1')).toBe(sodium.to_base64(theirs, variant()));
  });

  it('makes invitation MACs that are libsodium crypto_auth (HMAC-SHA-512-256)', () => {
    const key = invitationKey(newInvitationSecret(), 'room 1');
    const [alice, bob] = [generateIdentity().deviceId, generateIdentity().deviceId];
    const theirs = sodium.crypto_auth(invitationMacString(alice, bob, 'BB'), b64(key));
    expect(invitationMac(key, alice, bob, 'BB')).toBe(sodium.to_base64(theirs, variant()));
  });

  it('derives invitation token ids as the first 32 bytes of SHA-512', () => {
    const key = invitationKey(newInvitationSecret(), 'room 1');
    const input = new Uint8Array([...sodium.from_string('tc-invite-token-v1:'), ...b64(key)]);
    const theirs = sodium.crypto_hash(input).slice(0, 32); // libsodium's crypto_hash is SHA-512
    expect(invitationTokenId(key)).toBe(sodium.to_base64(theirs, variant()));
  });
});
