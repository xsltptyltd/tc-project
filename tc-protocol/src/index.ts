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
/**
 * How long an invitation code can be accepted, by default. A backend setting
 * (`Deps.invitationTtlSeconds`); local runs may change it, within the maximum below.
 */
export const INVITATION_TTL_SECONDS = 20;
/** An invitation is a bearer secret: it must stay short-lived, whatever the setting. */
export const INVITATION_TTL_MAX_SECONDS = 300;

const base64url = /^[A-Za-z0-9_-]+$/;

/** A device's identity: its Ed25519 public key, 32 bytes, base64url without padding. */
export const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

/**
 * Initials: 1 to 4 letters A–Z, upper case. Letters only, so that a label such as `PC2`
 * (D13) always reads as initials followed by a number; A–Z only, so that two labels that
 * look the same are the same. Clients upper-case what the person typed.
 */
export const InitialsSchema = z.string().regex(new RegExp(`^[A-Z]{1,${INITIALS_MAX_LENGTH}}$`));
export type Initials = z.infer<typeof InitialsSchema>;

/**
 * Names an invitation on the backend: a hash of the invitation's key, 32 bytes,
 * base64url. The backend never sees the key, the secret in the code, or the proximity
 * value the key is bound to (D1, D18).
 */
export const InvitationTokenIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The invitee's proof that it holds the invitation's secret: 32 bytes, base64url. */
export const InvitationMacSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

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
  /**
   * "Deliver this to `to`." Only to a contact: anyone else is refused with
   * `not_a_contact`, and nothing is stored (D19).
   */
  z.object({ action: z.literal('send'), to: DeviceIdSchema, ciphertext: CiphertextSchema }),
  /**
   * "I have this message; delete it." Only the receiver can delete a message. There is no
   * answer, whether or not the message existed, and the sender is never told (D9, D14).
   */
  z.object({ action: z.literal('ack'), messageId: z.string().min(1).max(64) }),
  /**
   * "Send me what is waiting for me." Sent by a device right after connecting: the
   * backend answers with one `message` event per unexpired message addressed to it,
   * oldest first, and nothing else. It is a frame rather than something the backend
   * does on connect because API Gateway cannot post to a connection during `$connect`.
   */
  z.object({ action: z.literal('fetch') }),
  /**
   * "Take back what I sent to `to` that has not been delivered yet": the one message
   * `messageId`, or, without it, all of them. Only the sender's own messages, and only
   * until the backend starts handing one to its receiver. There is no answer, whatever
   * was or was not deleted: anything else would tell the sender whether the receiver got
   * it (D14, D17).
   */
  z.object({
    action: z.literal('unsend'),
    to: DeviceIdSchema,
    messageId: z.string().min(1).max(64).optional(),
  }),
  /**
   * "I am showing an invitation; hold it for a short while." The inviter is taken from the
   * connection. The backend answers `invited` with how long the invitation lasts (D18).
   */
  z.object({ action: z.literal('invite'), tokenId: InvitationTokenIdSchema, initials: InitialsSchema }),
  /**
   * "I accept `inviter`'s invitation `tokenId`." The invitee is taken from the connection.
   * `mac` proves to the inviter that the invitee held the key — the code and the
   * proximity value — and that the backend did not change the invitee or its initials.
   * The backend makes the two contacts and answers `accepted`, or answers
   * `invitation_invalid` whatever the reason (D18).
   */
  z.object({
    action: z.literal('accept'),
    tokenId: InvitationTokenIdSchema,
    inviter: DeviceIdSchema,
    initials: InitialsSchema,
    mac: InvitationMacSchema,
  }),
  /**
   * "`contact` and I are no longer contacts." For both of us, at once: the backend deletes
   * the two records and every message still waiting between us, answers `removed`, and
   * tells both our devices (`contact_removed`). If we were not contacts it does nothing and
   * tells nobody. The same answer whether or not we were
   * contacts (D5).
   */
  z.object({ action: z.literal('remove'), contact: DeviceIdSchema }),
  /**
   * "Who are my contacts, as far as you know?" Answered with `contacts`. A device uses the
   * answer only to drop contacts the backend no longer has — never to add one (D20).
   */
  z.object({ action: z.literal('contacts') }),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

/**
 * `invitation_invalid`: unknown (which includes a code accepted from somewhere else than
 * beside the inviter), expired, already accepted, or not that inviter's. Which of these
 * is never said.
 * `not_a_contact`: a message to someone who is not a contact of the sender (D19).
 */
export type ErrorCode = 'bad_request' | 'unknown_connection' | 'invitation_invalid' | 'not_a_contact';

/**
 * Server → client frames.
 *
 * A sender is told only that the backend accepted a message. Nothing here may reveal
 * whether the receiver is connected, has received the message, or has read it.
 */
export type ServerEvent =
  | { type: 'message'; envelope: Envelope }
  | { type: 'sent'; messageId: string }
  /** Answer to `invite`: the invitation can be accepted for `expiresIn` seconds from now. */
  | { type: 'invited'; tokenId: string; expiresIn: number }
  /**
   * Answer to `accept`: the invitation was yours, and you and the inviter are now
   * contacts; here are the inviter's initials.
   */
  | { type: 'accepted'; inviter: DeviceId; initials: Initials }
  /**
   * To the inviter's connections: someone accepted invitation `tokenId`, and is now a
   * contact. The inviter checks `mac` with the invitation's key before believing any of it.
   */
  | { type: 'invitee'; tokenId: string; invitee: DeviceId; initials: Initials; mac: string }
  /** Answer to `remove`: you and `contact` are not contacts (any more). */
  | { type: 'removed'; contact: DeviceId }
  /**
   * To every connection of both sides of a removed contact: `contact` is no longer one of
   * yours. Sent to the one removed too — their device must drop it — but never shown to
   * them as news (D5).
   */
  | { type: 'contact_removed'; contact: DeviceId }
  /** Answer to `contacts`: the device ids the backend has as this device's contacts. */
  | { type: 'contacts'; contacts: DeviceId[] }
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
