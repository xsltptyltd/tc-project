// Two clients talking through the local server: the whole path, on one machine.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity, init } from 'tc-crypto';
import { startLocalServer, type LocalServer } from '../../ws-backend/lambdas/local/server';
import { TcClient, type IncomingMessage } from '../src';

let server: LocalServer;
const clients: TcClient[] = [];

async function connect(identity = generateIdentity()) {
  const client = new TcClient(identity, server.url);
  clients.push(client);
  await client.connect();
  return { client, identity };
}

const nextMessage = (client: TcClient) =>
  new Promise<IncomingMessage>((resolve) => client.onMessage(resolve));

beforeAll(() => init());
beforeEach(async () => {
  server = await startLocalServer();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
});

describe('end to end', () => {
  it('delivers a message only the receiver can read', async () => {
    const alice = await connect();
    const bob = await connect();
    const received = nextMessage(bob.client);

    const receipt = await alice.client.send(bob.identity.deviceId, 'see you at 8');

    expect(await received).toEqual({
      id: receipt.messageId,
      from: alice.identity.deviceId,
      text: 'see you at 8',
    });

    // What the server holds is unreadable.
    const stored = server.store.messages.get(receipt.messageId);
    expect(stored?.from).toBe(alice.identity.deviceId);
    expect(JSON.stringify(stored)).not.toContain('see you');
  });

  it('keeps the message when the receiver is offline', async () => {
    const alice = await connect();
    const bob = generateIdentity();

    const receipt = await alice.client.send(bob.deviceId, 'are you there?');

    expect(receipt).toEqual({ messageId: receipt.messageId });
    expect(server.store.messages.has(receipt.messageId)).toBe(true);
  });

  it('carries a conversation both ways', async () => {
    const alice = await connect();
    const bob = await connect();

    const toBob = nextMessage(bob.client);
    await alice.client.send(bob.identity.deviceId, 'ping');
    expect((await toBob).text).toBe('ping');

    const toAlice = nextMessage(alice.client);
    await bob.client.send(alice.identity.deviceId, 'pong');
    expect((await toAlice).text).toBe('pong');
  });

  it('reports a refused connection as a failed connect', async () => {
    const stranger = new TcClient(generateIdentity(), server.url);
    // sign with one identity while claiming another: the server must refuse
    const impostor = new TcClient(
      { ...generateIdentity(), deviceId: generateIdentity().deviceId },
      server.url,
    );
    await expect(impostor.connect()).rejects.toThrow('could not connect');
    await stranger.connect();
    await stranger.close();
  });

  it('tells the app when the connection ends', async () => {
    const alice = await connect();
    const closed = new Promise<void>((resolve) => alice.client.onClose(resolve));
    await server.close();
    await closed;
    expect(alice.client.connected).toBe(false);
    server = await startLocalServer();
  });

  it('refuses a connection without a valid proof', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${server.url}/?auth=nonsense`);
      socket.on('open', () => resolve('open'));
      socket.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
      socket.on('error', () => resolve('error'));
    });
    expect(outcome).toBe('http 401');
  });

  it('forgets a device when it disconnects', async () => {
    const alice = await connect();
    const bob = await connect();
    await bob.client.close();
    // the server processes the close asynchronously
    await expect
      .poll(async () => (await server.store.listConnections(bob.identity.deviceId)).length)
      .toBe(0);

    // sending still succeeds, and the sender cannot tell the difference
    const receipt = await alice.client.send(bob.identity.deviceId, 'gone?');
    expect(Object.keys(receipt)).toEqual(['messageId']);
  });
});
