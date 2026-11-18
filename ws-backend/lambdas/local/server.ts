// A websocket server that runs the same core logic as the Lambdas, with everything in
// memory. For development and end-to-end tests; it is not how the backend is deployed.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { INVITATION_TTL_SECONDS, MESSAGE_TTL_SECONDS, type ServerEvent } from 'tc-protocol';
import { MemoryStore } from '../src/adapters/memory-store';
import { verifyAuthToken } from '../src/core/auth';
import { onConnect, onDisconnect } from '../src/core/connections';
import type { ContactStore, Deps, Store } from '../src/core/ports';
import { onMessage } from '../src/core/router';

export interface LocalServer<S = MemoryStore> {
  port: number;
  url: string;
  store: S;
  close(): Promise<void>;
}

export interface LocalServerOptions<S> {
  /**
   * Where everything is kept: in memory by default. Tests pass the DynamoDB store, talking
   * to a stand-in client, to run the whole system on it.
   */
  store?: S;
  /** How long an unacknowledged message is kept. Default: 24 hours. */
  messageTtlSeconds?: number;
  /** How long an invitation can be accepted. Default: 20 seconds. */
  invitationTtlSeconds?: number;
  /** How often expired messages and invitations are swept from memory. Default: every second. */
  sweepIntervalMs?: number;
}

export async function startLocalServer<S extends Store & ContactStore = MemoryStore>(
  port = 0,
  host = '127.0.0.1',
  {
    store: given,
    messageTtlSeconds = MESSAGE_TTL_SECONDS,
    invitationTtlSeconds = INVITATION_TTL_SECONDS,
    sweepIntervalMs = 1000,
  }: LocalServerOptions<S> = {},
): Promise<LocalServer<S>> {
  const now = () => Math.floor(Date.now() / 1000);
  const store = given ?? (new MemoryStore(now) as Store & ContactStore as S);
  // Memory needs sweeping; DynamoDB has its TTL (D8).
  const stopSweeping = store instanceof MemoryStore ? store.startSweeping(sweepIntervalMs) : () => {};
  const sockets = new Map<string, WebSocket>();

  const deps: Deps = {
    store,
    now,
    newId: randomUUID,
    messageTtlSeconds,
    contacts: store,
    invitationTtlSeconds,
    transport: {
      async post(connectionId: string, event: ServerEvent): Promise<boolean> {
        const socket = sockets.get(connectionId);
        if (!socket || socket.readyState !== socket.OPEN) return false;
        socket.send(JSON.stringify(event));
        return true;
      },
    },
  };

  const http = createServer((_req, res) => {
    res.writeHead(426).end();
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const auth = new URL(req.url ?? '/', 'http://localhost').searchParams.get('auth');
    const result = verifyAuthToken(auth ?? undefined, now());
    if (!result.ok) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connectionId = randomUUID();
      sockets.set(connectionId, ws);
      const connected = onConnect(deps, connectionId, result.deviceId);
      ws.on('message', (data) => {
        void connected.then(() => onMessage(deps, connectionId, data.toString()));
      });
      ws.on('close', () => {
        sockets.delete(connectionId);
        void connected.then(() => onDisconnect(deps, connectionId));
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  const actualPort = (http.address() as AddressInfo).port;

  return {
    port: actualPort,
    url: `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    store,
    async close() {
      stopSweeping();
      for (const socket of sockets.values()) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
