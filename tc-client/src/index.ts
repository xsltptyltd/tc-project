// One device's connection to the backend: connect, send, receive.
// Uses the standard WebSocket interface, which exists in Node 22+, in browsers and in
// React Native, so the command-line client and the phone app share this code.
import { createAuthToken, decryptFrom, encryptFor, type Identity } from 'tc-crypto';
import type { ClientAction, DeviceId, ErrorCode, ServerEvent } from 'tc-protocol';

export interface IncomingMessage {
  id: string;
  from: DeviceId;
  text: string;
}

/** Confirms the backend accepted a message. It says nothing about the receiver. */
export interface SendReceipt {
  messageId: string;
}

export class ServerError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`server error: ${code}`);
  }
}

/** Call `init()` from tc-crypto before using this. */
export class TcClient {
  private socket?: WebSocket;
  // The backend answers frames in order, so replies are matched first in, first out.
  private pending: Array<{ resolve(r: SendReceipt): void; reject(e: Error): void }> = [];
  private messageListeners: Array<(message: IncomingMessage) => void> = [];
  private closeListeners: Array<() => void> = [];
  // A message sent while we are connecting can arrive twice: live, and in the answer
  // to `fetch`. Listeners see each message once.
  private delivered = new Set<string>();

  constructor(
    private readonly identity: Identity,
    private readonly url: string,
  ) { }

  get connected(): boolean {
    return this.socket?.readyState === 1; // WebSocket.OPEN
  }

  /** Rejects if the server is unreachable or refuses the connection. */
  connect(): Promise<void> {
    const token = createAuthToken(this.identity, Math.floor(Date.now() / 1000));
    const socket = new WebSocket(`${this.url.replace(/\/+$/, '')}/?auth=${token}`);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let opened = false;
      socket.onopen = () => {
        opened = true;
        // Ask for whatever arrived while this device was offline.
        socket.send(JSON.stringify({ action: 'fetch' } satisfies ClientAction));
        resolve();
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') this.handle(JSON.parse(event.data) as ServerEvent);
      };
      socket.onerror = () => {
        if (!opened) reject(new Error('could not connect'));
      };
      socket.onclose = () => {
        if (!opened) reject(new Error('could not connect'));
        for (const waiting of this.pending.splice(0)) waiting.reject(new Error('connection closed'));
        if (opened) for (const listener of this.closeListeners) listener();
      };
    });
  }

  onMessage(listener: (message: IncomingMessage) => void): void {
    this.messageListeners.push(listener);
  }

  /** Called when an established connection ends, whoever ended it. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  send(to: DeviceId, text: string): Promise<SendReceipt> {
    const action: ClientAction = {
      action: 'send',
      to,
      ciphertext: encryptFor(this.identity, to, { v: 1, text }),
    };
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('not connected'));
        return;
      }
      this.pending.push({ resolve, reject });
      this.socket.send(JSON.stringify(action));
    });
  }

  /**
   * Takes back what this device sent to `to` and has not been delivered yet: the one
   * message `messageId`, or all of them. The backend does not answer, so there is no way
   * to know what was deleted — by design: that would say whether the receiver got it.
   */
  unsend(to: DeviceId, messageId?: string): void {
    if (!this.socket || !this.connected) throw new Error('not connected');
    const action: ClientAction = { action: 'unsend', to, ...(messageId !== undefined && { messageId }) };
    this.socket.send(JSON.stringify(action));
  }

  close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === 3) return Promise.resolve(); // WebSocket.CLOSED
    return new Promise((resolve) => {
      this.closeListeners.push(resolve);
      socket.close();
    });
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'message': {
        const { id, from, ciphertext } = event.envelope;
        if (this.delivered.has(id)) return;
        let text: string;
        try {
          text = decryptFrom(this.identity, from, ciphertext).text;
        } catch {
          return; // not for us, or not from who it claims: drop it
        }
        if (this.messageListeners.length === 0) return; // nobody to give it to: keep it
        this.delivered.add(id);
        for (const listener of this.messageListeners) listener({ id, from, text });
        // The app has it now, so the backend deletes it (D9): from here on it exists only
        // in this app's memory. If the connection is already gone, it comes again next time.
        if (this.connected) {
          this.socket?.send(JSON.stringify({ action: 'ack', messageId: id } satisfies ClientAction));
        }
        return;
      }
      case 'sent':
        this.pending.shift()?.resolve({ messageId: event.messageId });
        return;
      case 'error':
        this.pending.shift()?.reject(new ServerError(event.code));
        return;
    }
  }
}
