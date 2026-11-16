import type { DeviceId, Envelope } from 'tc-protocol';
import type { Connection, Store } from '../core/ports';

/** In-memory Store for tests and the local server. Nothing survives a restart. */
export class MemoryStore implements Store {
  readonly connections = new Map<string, Connection>();
  readonly messages = new Map<string, Envelope>();

  async putConnection(connection: Connection): Promise<void> {
    this.connections.set(connection.connectionId, connection);
  }
  async deleteConnection(connectionId: string): Promise<void> {
    this.connections.delete(connectionId);
  }
  async getConnection(connectionId: string): Promise<Connection | undefined> {
    return this.connections.get(connectionId);
  }
  async listConnections(deviceId: DeviceId): Promise<Connection[]> {
    return [...this.connections.values()].filter((c) => c.deviceId === deviceId);
  }
  async putMessage(envelope: Envelope): Promise<void> {
    this.messages.set(envelope.id, envelope);
  }
}
