// Everything the core logic needs from the outside world. The handlers never touch
// AWS directly: they are given these, so tests and the local server can supply
// in-memory versions.
import type { DeviceId, Envelope, ServerEvent } from 'tc-protocol';

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
}
