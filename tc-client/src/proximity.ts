// Proof that the inviter and the invitee are side by side (design/DECISIONS.md D1, D18).
//
// The inviter announces a value that only devices near it can learn; the invitee senses
// it. The value is mixed into the invitation's key, so it is never sent anywhere — not
// to the backend, not to the other device — and a code read anywhere else than beside
// the inviter yields a key that matches no invitation.
//
// Where the app runs decides how the value travels, so it sits behind `Proximity`:
//
//   terminal  a room: both people set the same TC_ROOM (cli/src/room.ts). A stand-in,
//             good enough to develop with: anyone who knows the room name is "nearby".
//   phone     (not built) Bluetooth: the inviter advertises a random value, rotating
//             with its QR code; the invitee scans for it, ignoring anything whose signal
//             is too weak to be close (D1).
import type { Invitation } from './invitation';

/** The device cannot take part in proximity at all: no room set, Bluetooth off, no permission… */
export class ProximityUnavailable extends Error {
  override name = 'ProximityUnavailable';
}

/** What the inviter is announcing, for as long as its invitation is open. */
export interface Announcement {
  /** Known to the devices nearby. Never sent. */
  value: string;
  /** Stops announcing: the invitation was accepted, expired, or was replaced. */
  stop(): void;
}

export interface Proximity {
  /**
   * Inviter: starts announcing a value to devices nearby, for this invitation. Rejects
   * with `ProximityUnavailable` if it cannot — the invitation is then never shown.
   */
  announce(invitation: Invitation): Promise<Announcement>;
  /**
   * Invitee: the value announced by the inviter of `invitation` (which tells a scanner
   * whose announcement to listen for when several devices are nearby). Rejects with
   * `ProximityUnavailable` if it cannot — before anything reaches the backend, so the
   * invitation is not used up and the invitee can try again.
   */
  sense(invitation: Invitation): Promise<string>;
}
