import type { DeviceId, Envelope } from 'tc-protocol';
import type { Connection, Store } from '../core/ports';

/** In-memory Store for tests and the local server. Nothing survives a restart. */
export class MemoryStore implements Store {
  readonly connections = new Map<string, Connection>();
  readonly messages = new Map<string, Envelope>();
  /** Ids of stored messages that have been handed to their receiver at least once. */
  readonly delivered = new Set<string>();

  /** @param now epoch seconds; what the sweeper compares `expiresAt` with */
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /** Deletes every expired message, whoever it is for. */
  sweep(now = this.now()): void {
    for (const message of this.messages.values()) {
      if (message.expiresAt <= now) this.remove(message.id);
    }
  }

  /**
   * Sweeps every `intervalMs` until the returned function is called — what DynamoDB's
   * TTL does for the real table, so an expired message is deleted even if nobody ever
   * asks for it. It does not keep the process alive.
   */
  startSweeping(intervalMs: number): () => void {
    const timer = setInterval(() => this.sweep(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

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
  async listMessages(deviceId: DeviceId, now: number): Promise<Envelope[]> {
    // Sweeping first means nothing expired is returned, even between two timed sweeps.
    this.sweep(now);
    // A Map iterates in insertion order, which is the order they were sent.
    return [...this.messages.values()].filter((message) => message.to === deviceId);
  }
  async deleteMessage(deviceId: DeviceId, messageId: string): Promise<void> {
    if (this.messages.get(messageId)?.to === deviceId) this.remove(messageId);
  }
  async markDelivered(to: DeviceId, messageId: string): Promise<boolean> {
    if (this.messages.get(messageId)?.to !== to) return false;
    this.delivered.add(messageId);
    return true;
  }
  async unsendMessages(from: DeviceId, to: DeviceId, messageId?: string): Promise<void> {
    for (const message of this.messages.values()) {
      if (messageId !== undefined && message.id !== messageId) continue;
      if (message.from === from && message.to === to && !this.delivered.has(message.id)) {
        this.remove(message.id);
      }
    }
  }

  /** Nothing about a deleted message is kept, not even that it was delivered. */
  private remove(messageId: string): void {
    this.messages.delete(messageId);
    this.delivered.delete(messageId);
  }
}
