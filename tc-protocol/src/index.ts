// Wire contract between tap-chat clients and the backend.
// Types, constants and validation only — no crypto, no I/O.
import { z } from 'zod';

/** How long the backend keeps an unacknowledged message. */
export const MESSAGE_TTL_SECONDS = 24 * 60 * 60;
/** How far a client clock may be from the server's when authenticating. */
export const AUTH_MAX_SKEW_SECONDS = 60;
/** Upper bound on the encrypted body of one message, in base64url characters. */
export const MAX_CIPHERTEXT_LENGTH = 16 * 1024;
/** A person is known to the backend only by their initials: 1 to 4 letters. */
export const INITIALS_MAX_LENGTH = 4;

const base64url = /^[A-Za-z0-9_-]+$/;

/** A device's identity: its Ed25519 public key, 32 bytes, base64url without padding. */
export const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const CiphertextSchema = z.string().min(1).max(MAX_CIPHERTEXT_LENGTH).regex(base64url);

/** What the backend stores and relays. It can read every field except `ciphertext`. */
export const EnvelopeSchema = z.object({
  id: z.string().min(1).max(64),
  from: DeviceIdSchema,
  to: DeviceIdSchema,
  ciphertext: CiphertextSchema,
  /** epoch seconds, set by the backend */
  sentAt: z.number().int(),
  /** epoch seconds, set by the backend; readers must ignore anything past this */
  expiresAt: z.number().int(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** What is inside `ciphertext` once decrypted. Never seen by the backend. */
export const PayloadSchema = z.object({
  v: z.literal(1),
  text: z.string(),
});
export type Payload = z.infer<typeof PayloadSchema>;

/** Client → server frames. `action` is also the API Gateway route selection key. */
export const ClientActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), to: DeviceIdSchema, ciphertext: CiphertextSchema }),
  z.object({ action: z.literal('ack'), messageId: z.string().min(1).max(64) }),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

export type ErrorCode = 'bad_request' | 'unknown_connection' | 'not_implemented';

/**
 * Server → client frames.
 *
 * A sender is told only that the backend accepted a message. Nothing here may reveal
 * whether the receiver is connected, has received the message, or has read it.
 */
export type ServerEvent =
  | { type: 'message'; envelope: Envelope }
  | { type: 'sent'; messageId: string }
  | { type: 'error'; code: ErrorCode };

// ---- authentication -------------------------------------------------------
// A client proves it holds the private key of its device id by signing
// `authSigningString(deviceId, ts)`. The proof travels as `deviceId.ts.signature`.

export interface AuthToken {
  deviceId: DeviceId;
  /** epoch seconds on the client's clock */
  ts: number;
  /** Ed25519 signature, 64 bytes, base64url without padding */
  sig: string;
}

export function authSigningString(deviceId: DeviceId, ts: number): string {
  return `tc-auth-v1:${deviceId}:${ts}`;
}

export function formatAuthToken(token: AuthToken): string {
  return `${token.deviceId}.${token.ts}.${token.sig}`;
}

export function parseAuthToken(raw: string): AuthToken | undefined {
  const parts = raw.split('.');
  if (parts.length !== 3) return undefined;
  const [deviceId, tsRaw, sig] = parts;
  if (!DeviceIdSchema.safeParse(deviceId).success) return undefined;
  if (!/^\d{1,12}$/.test(tsRaw)) return undefined;
  if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) return undefined;
  return { deviceId, ts: Number(tsRaw), sig };
}
