// Two clients talking through the local server: the whole path, on one machine.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { encryptFor, generateIdentity, init } from 'tc-crypto';
import { startLocalServer, type LocalServer } from '../../ws-backend/lambdas/local/server';
import { REMEMBERED_IDS, TcClient, type IncomingMessage } from '../src';

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

  it('delivers messages sent while the receiver was offline once it connects', async () => {
    const alice = await connect();
    const bob = generateIdentity();
    await alice.client.send(bob.deviceId, 'first');
    await alice.client.send(bob.deviceId, 'second');

    const bobClient = new TcClient(bob, server.url);
    clients.push(bobClient);
    const received: string[] = [];
    bobClient.onMessage((m) => received.push(`${m.from === alice.identity.deviceId ? 'alice' : '?'}: ${m.text}`));
    await bobClient.connect();

    await expect.poll(() => received).toEqual(['alice: first', 'alice: second']);
  });

  it('delivers to a receiver that is already online straight away, once', async () => {
    const alice = await connect();
    const bob = await connect();
    const received: string[] = [];
    bob.client.onMessage((m) => received.push(m.text));

    await alice.client.send(bob.identity.deviceId, 'now');
    await expect.poll(() => received).toEqual(['now']);
    // a later message is not preceded by a second copy of the first
    await alice.client.send(bob.identity.deviceId, 'and now');
    await expect.poll(() => received).toEqual(['now', 'and now']);
  });

  it('deletes a message from the server once the receiver has it', async () => {
    const alice = await connect();
    const bob = await connect();
    const received = nextMessage(bob.client);

    const receipt = await alice.client.send(bob.identity.deviceId, 'read once');
    await received;

    await expect.poll(() => server.store.messages.has(receipt.messageId)).toBe(false);
  });

  it('does not deliver a message again to someone joining a second time', async () => {
    const alice = await connect();
    const bob = generateIdentity();
    await alice.client.send(bob.deviceId, 'only once');

    const first = new TcClient(bob, server.url);
    clients.push(first);
    const firstTime: string[] = [];
    first.onMessage((m) => firstTime.push(m.text));
    await first.connect();
    await expect.poll(() => firstTime).toEqual(['only once']);
    await first.close();

    const second = new TcClient(bob, server.url);
    clients.push(second);
    const secondTime: string[] = [];
    second.onMessage((m) => secondTime.push(m.text));
    await second.connect();
    // Something new, to know that the fetch has been answered by the time it arrives.
    await alice.client.send(bob.deviceId, 'new');
    await expect.poll(() => secondTime).toEqual(['new']);
    expect(server.store.messages.size).toBe(0);
  });

  it('deletes a message nobody received once its lifetime is over, in real time', async () => {
    await server.close();
    server = await startLocalServer(0, '127.0.0.1', { messageTtlSeconds: 1 });
    const alice = await connect();
    const bob = generateIdentity();

    await alice.client.send(bob.deviceId, 'too late');
    // Nobody asks for it: only the server's sweeper can remove it.
    await expect.poll(() => server.store.messages.size, { timeout: 3000 }).toBe(0);

    const late = new TcClient(bob, server.url);
    clients.push(late);
    const received: string[] = [];
    late.onMessage((m) => received.push(m.text));
    await late.connect();
    await alice.client.send(bob.deviceId, 'in time'); // live, and marks the fetch as answered
    await expect.poll(() => received).toEqual(['in time']);
  });

  it('lets the sender take back what the receiver has not received', async () => {
    const alice = await connect();
    const bob = generateIdentity();
    await alice.client.send(bob.deviceId, 'forget this');
    await alice.client.send(bob.deviceId, 'and this');

    alice.client.unsend(bob.deviceId);
    await expect.poll(() => server.store.messages.size).toBe(0);

    const late = new TcClient(bob, server.url);
    clients.push(late);
    const received: string[] = [];
    late.onMessage((m) => received.push(m.text));
    await late.connect();
    await alice.client.send(bob.deviceId, 'hello'); // live, and marks the fetch as answered
    await expect.poll(() => received).toEqual(['hello']);
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

describe('client', () => {
  // Stands in for the server, to produce situations the real one only hits by timing.
  async function fakeServer(onFrame: (frame: string, socket: WebSocket) => void) {
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => fake.once('listening', resolve));
    const frames: string[] = [];
    fake.on('connection', (socket) =>
      socket.on('message', (data) => {
        frames.push(data.toString());
        onFrame(data.toString(), socket);
      }),
    );
    return {
      url: `ws://127.0.0.1:${(fake.address() as { port: number }).port}`,
      frames,
      close: () => new Promise((resolve) => fake.close(resolve)),
    };
  }

  const alice = generateIdentity();
  const bob = generateIdentity();
  const carol = generateIdentity();
  const envelope = (id: string, ciphertext = encryptFor(alice, bob.deviceId, { v: 1, text: id })) => ({
    type: 'message',
    envelope: { id, from: alice.deviceId, to: bob.deviceId, ciphertext, sentAt: 1_800_000_000, expiresAt: 1_800_086_400 },
  });

  it('asks for waiting messages on connect, reports each once and acknowledges each once', async () => {
    // A message sent while the receiver is connecting reaches it twice: live, and in the
    // answer to fetch. One it cannot decrypt is dropped and not acknowledged.
    const fake = await fakeServer((frame, socket) => {
      if (frame !== JSON.stringify({ action: 'fetch' })) return;
      for (const event of [
        envelope('m1'),
        envelope('m1'),
        envelope('m2'),
        envelope('m3', encryptFor(alice, carol.deviceId, { v: 1, text: 'for carol' })),
      ]) {
        socket.send(JSON.stringify(event));
      }
    });
    try {
      const client = new TcClient(bob, fake.url);
      const received: string[] = [];
      client.onMessage((m) => received.push(m.id));
      await client.connect();

      await expect.poll(() => fake.frames.length).toBe(3);
      expect(received).toEqual(['m1', 'm2']);
      expect(fake.frames).toEqual([
        JSON.stringify({ action: 'fetch' }),
        JSON.stringify({ action: 'ack', messageId: 'm1' }),
        JSON.stringify({ action: 'ack', messageId: 'm2' }),
      ]);
      await client.close();
    } finally {
      await fake.close();
    }
  });

  it('acknowledges again, without showing again, a message that comes back on a later connection', async () => {
    // The first acknowledgement was lost with the connection, so the backend still has
    // the message and sends it again. The app already showed it.
    const fake = await fakeServer((frame, socket) => {
      if (frame === JSON.stringify({ action: 'fetch' })) socket.send(JSON.stringify(envelope('m1')));
    });
    try {
      const client = new TcClient(bob, fake.url);
      const received: string[] = [];
      client.onMessage((m) => received.push(m.id));
      await client.connect();
      await expect.poll(() => fake.frames.length).toBe(2);
      await client.close();
      await client.connect();
      await expect.poll(() => fake.frames.length).toBe(4);

      expect(received).toEqual(['m1']);
      expect(fake.frames.filter((f) => f.includes('"ack"'))).toEqual([
        JSON.stringify({ action: 'ack', messageId: 'm1' }),
        JSON.stringify({ action: 'ack', messageId: 'm1' }),
      ]);
      await client.close();
    } finally {
      await fake.close();
    }
  });

  it('remembers only the most recent ids, so a long-running app does not grow', async () => {
    const total = REMEMBERED_IDS + 5;
    const fake = await fakeServer((frame, socket) => {
      if (frame !== JSON.stringify({ action: 'fetch' })) return;
      for (let i = 0; i < total; i++) socket.send(JSON.stringify(envelope(`m${i}`, sealed)));
      socket.send(JSON.stringify(envelope('m0', sealed))); // forgotten by now: shown again
      socket.send(JSON.stringify(envelope(`m${total - 1}`, sealed))); // still remembered
    });
    const sealed = encryptFor(alice, bob.deviceId, { v: 1, text: 'x' });
    try {
      const client = new TcClient(bob, fake.url);
      const received: string[] = [];
      client.onMessage((m) => received.push(m.id));
      await client.connect();
      await expect.poll(() => received.length).toBe(total + 1);
      expect(received.at(-1)).toBe('m0');
      await client.close();
    } finally {
      await fake.close();
    }
  });

  it('sends unsend for one message or for all, and gets no answer', async () => {
    const fake = await fakeServer(() => {});
    try {
      const client = new TcClient(alice, fake.url);
      await client.connect();
      client.unsend(bob.deviceId, 'm1');
      client.unsend(bob.deviceId);
      await expect.poll(() => fake.frames.length).toBe(3);
      expect(fake.frames.slice(1).map((f) => JSON.parse(f))).toEqual([
        { action: 'unsend', to: bob.deviceId, messageId: 'm1' },
        { action: 'unsend', to: bob.deviceId },
      ]);
      await client.close();
    } finally {
      await fake.close();
    }
  });

  it('refuses to unsend when not connected', () => {
    expect(() => new TcClient(alice, 'ws://127.0.0.1:1').unsend(bob.deviceId)).toThrow('not connected');
  });

  it('does not acknowledge a message nobody was listening for', async () => {
    const fake = await fakeServer((frame, socket) => {
      if (frame === JSON.stringify({ action: 'fetch' })) {
        socket.send(JSON.stringify(envelope('m1')));
        socket.send(JSON.stringify({ type: 'sent', messageId: 'done' })); // marks the end
      }
    });
    try {
      const client = new TcClient(bob, fake.url);
      await client.connect();
      await client.send(alice.deviceId, 'x'); // resolves on the marker, after m1 was handled
      expect(fake.frames.filter((f) => f.includes('"ack"'))).toEqual([]);
      await client.close();
    } finally {
      await fake.close();
    }
  });
});
