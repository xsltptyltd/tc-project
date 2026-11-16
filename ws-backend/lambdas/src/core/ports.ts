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
}
