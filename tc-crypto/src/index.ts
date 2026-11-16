// Client-side identity and message encryption.
//
// The formats are those of NaCl / libsodium (Ed25519 signatures, crypto_box), implemented
// with TweetNaCl, which is plain JavaScript: the same code runs in Node and in React
// Native with no native module. test/libsodium-compat.test.ts checks the output against
// libsodium itself. The backend never imports this package: it only verifies signatures.
import ed2curve from 'ed2curve';
import nacl from 'tweetnacl';
import {
  authSigningString,
  formatAuthToken,
  PayloadSchema,
  type DeviceId,
  type Payload,
} from 'tc-protocol';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './encoding';

export interface Identity {
  /** Ed25519 public key, base64url. This is what other people add as a contact. */
  deviceId: DeviceId;
  /** Ed25519 seed (32 bytes), base64url. Never leaves the device. */
  secretKey: string;
}

export interface InitOptions {
  /**
   * Source of secure random bytes. Needed where the runtime has no
   * `crypto.getRandomValues` (React Native): pass the platform's generator.
   */
  randomBytes?: (length: number) => Uint8Array;
}

/** Call once before anything else. */
export async function init(options: InitOptions = {}): Promise<void> {
  const { randomBytes } = options;
  if (randomBytes) {
    nacl.setPRNG((target, length) => target.set(randomBytes(length)));
  }
}

export function generateIdentity(): Identity {
  const seed = nacl.randomBytes(nacl.sign.seedLength);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return { deviceId: toBase64Url(pair.publicKey), secretKey: toBase64Url(seed) };
}

const signingKey = (identity: Identity) =>
  nacl.sign.keyPair.fromSeed(fromBase64Url(identity.secretKey)).secretKey;

/** The proof a client presents when opening a connection. */
export function createAuthToken(identity: Identity, nowSeconds: number): string {
  const sig = nacl.sign.detached(
    utf8Encode(authSigningString(identity.deviceId, nowSeconds)),
    signingKey(identity),
  );
  return formatAuthToken({ deviceId: identity.deviceId, ts: nowSeconds, sig: toBase64Url(sig) });
}

// Encryption keys are derived from the signing keys, so a device id is the only thing
// two people need to exchange.
function boxPublicKey(deviceId: DeviceId): Uint8Array {
  const key = ed2curve.convertPublicKey(fromBase64Url(deviceId));
  if (!key) throw new Error('not a valid device id');
  return key;
}
const boxSecretKey = (identity: Identity) => ed2curve.convertSecretKey(signingKey(identity));

/** Encrypts for one receiver. Output is base64url(nonce || box). */
export function encryptFor(sender: Identity, to: DeviceId, payload: Payload): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(
    utf8Encode(JSON.stringify(payload)),
    nonce,
    boxPublicKey(to),
    boxSecretKey(sender),
  );
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return toBase64Url(out);
}

/**
 * Decrypts a message and checks it really came from `from`.
 * Throws if the message was not encrypted by `from` for this receiver, or was altered.
 */
export function decryptFrom(receiver: Identity, from: DeviceId, ciphertext: string): Payload {
  const bytes = fromBase64Url(ciphertext);
  const nonceLength = nacl.box.nonceLength;
  if (bytes.length <= nonceLength) throw new Error('ciphertext too short');
  const plain = nacl.box.open(
    bytes.subarray(nonceLength),
    bytes.subarray(0, nonceLength),
    boxPublicKey(from),
    boxSecretKey(receiver),
  );
  if (!plain) throw new Error('message could not be decrypted');
  return PayloadSchema.parse(JSON.parse(utf8Decode(plain)));
}
