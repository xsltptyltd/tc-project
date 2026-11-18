// How an invitation travels from the inviter's screen to the invitee's device, outside
// the backend (design/DECISIONS.md D1, D18).
//
// What travels is always the same two things: the inviter's device id and a one-time
// secret. How they travel depends on where the app runs, so it sits behind
// `InvitationCodec`:
//
//   terminal  `textInvitationCodec` — a line of text, copied from one terminal to another.
//   phone     (not built) a universal link `https://<host>/…#<text code>` shown as a QR
//             code; the camera or the in-app scanner opens the app with that link. The
//             code stays in the fragment (after `#`), so it never reaches a web server.
//
// Proving the two devices are side by side is a separate seam, `Proximity`
// (./proximity.ts). Everything else — registering the invitation, accepting it, checking
// the MAC — is in `TcClient` and is the same for both.
import { isInvitationSecret } from 'tc-crypto';
import { DeviceIdSchema, type DeviceId } from 'tc-protocol';

/** What the inviter shows and the invitee reads. Whoever holds it can accept it. */
export interface Invitation {
  inviter: DeviceId;
  /** 32 random bytes, base64url. Never sent to the backend. */
  secret: string;
}

/** Turns an invitation into something to show, and back. */
export interface InvitationCodec {
  encode(invitation: Invitation): string;
  /** Undefined for anything that is not an invitation: mistyped, cut short, or other. */
  decode(shown: string): Invitation | undefined;
}

const TEXT_PREFIX = 'tc1';

/**
 * `tc1.<inviter device id>.<secret>` — one word of base64url and dots, so it survives
 * copying from a terminal. Surrounding whitespace is ignored when reading it.
 */
export const textInvitationCodec: InvitationCodec = {
  encode: ({ inviter, secret }) => `${TEXT_PREFIX}.${inviter}.${secret}`,
  decode(shown) {
    const parts = shown.trim().split('.');
    if (parts.length !== 3 || parts[0] !== TEXT_PREFIX) return undefined;
    const [, inviter, secret] = parts;
    // A mistyped last character can still look like base64url: check it really decodes.
    if (!DeviceIdSchema.safeParse(inviter).success || !isInvitationSecret(secret!)) return undefined;
    return { inviter: inviter!, secret: secret! };
  },
};

/** The inviter's view of an invitation it is showing. */
export interface OpenInvitation {
  invitation: Invitation;
  /** Seconds from now during which the backend lets it be accepted. */
  expiresIn: number;
  /**
   * Stops announcing and forgets the key — when the invitation is no longer shown. Done
   * on its own once it is accepted or has expired.
   */
  close(): void;
}
