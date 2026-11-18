// Everything the core logic needs from the outside world. The handlers never touch
// AWS directly: they are given these, so tests and the local server can supply
// in-memory versions.
import type { DeviceId, Envelope, Initials, ServerEvent } from 'tc-protocol';

export interface Connection {
  connectionId: string;
  deviceId: DeviceId;
  /** epoch seconds */
  connectedAt: number;
}

export interface Store {
  putConnection(connection: Connection): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
  getConnection(connectionId: string): Promise<Connection | undefined>;
  /** A device may be connected more than once. */
  listConnections(deviceId: DeviceId): Promise<Connection[]>;
  putMessage(envelope: Envelope): Promise<void>;
  /**
   * Messages addressed to `deviceId`, oldest first (two sent within the same second may
   * come in either order). Only those with `expiresAt > now`: expiry is enforced here,
   * on read, whatever the storage does on its own (D8).
   */
  listMessages(deviceId: DeviceId, now: number): Promise<Envelope[]>;
  /**
   * Deletes message `messageId` if it is addressed to `deviceId`, and does nothing
   * otherwise: a device can only ever delete its own incoming messages.
   */
  deleteMessage(deviceId: DeviceId, messageId: string): Promise<void>;
  /**
   * Records that message `messageId` to `to` is being handed to its receiver; from then
   * on its sender can no longer take it back. Resolves false if the message no longer
   * exists (taken back, acknowledged or expired): it must then not be delivered.
   */
  markDelivered(to: DeviceId, messageId: string): Promise<boolean>;
  /**
   * Deletes what `from` sent to `to` and was never marked delivered: the one message
   * `messageId` if given, otherwise all of them. Anything else is left alone.
   */
  unsendMessages(from: DeviceId, to: DeviceId, messageId?: string): Promise<void>;
  /**
   * Deletes every message between `a` and `b`, in both directions, delivered or not:
   * what happens to them when the two stop being contacts (D5).
   */
  deleteMessagesBetween(a: DeviceId, b: DeviceId): Promise<void>;
}

/**
 * An invitation waiting to be accepted (D1, D18). The backend knows it by a hash of its
 * key and never sees the key, the secret in the code, or the proximity value. The
 * initials are the inviter's, given with the invitation: they are kept only as long as
 * the invitation.
 */
export interface InvitationRecord {
  tokenId: string;
  inviter: DeviceId;
  initials: Initials;
  /** epoch seconds; it cannot be accepted from then on */
  expiresAt: number;
  /** Set by the first acceptance; nobody can accept it after that. */
  acceptedBy?: DeviceId;
}

/**
 * Invitations, and the contacts they create (D5, D18, D19). Both stores implement it
 * next to `Store`; kept apart because it is its own concern.
 */
export interface ContactStore {
  /** Resolves false, and changes nothing, if an invitation with that token id exists. */
  putInvitation(invitation: InvitationRecord): Promise<boolean>;
  /**
   * Accepts invitation `tokenId` for `invitee`, once: only if it exists, is `inviter`'s,
   * has `expiresAt > now` and was not accepted yet. In the same step, the inviter and the
   * invitee become contacts of each other — two mirrored records, both or neither (D5);
   * if they already were, nothing changes. All of it is checked and written as one
   * step, so two devices racing for one invitation cannot both get it. Resolves the
   * invitation as accepted, or undefined, without saying why.
   */
  acceptInvitation(
    tokenId: string,
    parties: { inviter: DeviceId; invitee: DeviceId },
    now: number,
  ): Promise<InvitationRecord | undefined>;
  /** Whether `other` is a contact of `owner`. */
  isContact(owner: DeviceId, other: DeviceId): Promise<boolean>;
  /** Every contact of `owner`. */
  listContacts(owner: DeviceId): Promise<DeviceId[]>;
  /**
   * Ends the contact between `a` and `b`: both records, together (D5). Nothing about it
   * is kept. Doing it again, or for two who never were contacts, changes nothing.
   */
  removeContact(a: DeviceId, b: DeviceId): Promise<void>;
}

export interface Transport {
  /** Resolves false when the connection no longer exists. */
  post(connectionId: string, event: ServerEvent): Promise<boolean>;
}

export interface Deps {
  store: Store;
  transport: Transport;
  /** epoch seconds */
  now(): number;
  newId(): string;
  /**
   * How long an unacknowledged message is kept. MESSAGE_TTL_SECONDS (24 hours) when
   * deployed; tests and local runs may use less, to watch messages expire.
   */
  messageTtlSeconds: number;
  contacts: ContactStore;
  /**
   * How long an invitation can be accepted. INVITATION_TTL_SECONDS (20 s) by default;
   * never more than INVITATION_TTL_MAX_SECONDS.
   */
  invitationTtlSeconds: number;
}
