// What every Store must do, run against each implementation: the in-memory one, and the
// DynamoDB one talking to an in-memory stand-in for the DynamoDB client. The second half
// runs whole conversations through the router on each, so the two cannot drift apart.
import { describe, expect, it } from 'vitest';
import { MESSAGE_TTL_SECONDS, type Envelope, type ServerEvent } from 'tc-protocol';
import { DynamoStore } from '../src/adapters/dynamodb-store';
import { MemoryStore } from '../src/adapters/memory-store';
import { onConnect, onDisconnect } from '../src/core/connections';
import type { Deps, Store } from '../src/core/ports';
import { onMessage } from '../src/core/router';
import { FakeDynamoDB } from './fake-dynamodb';
import { newDevice } from './helpers';

const NOW = 1_800_000_000;
const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  id: 'm1',
  from: alice,
  to: bob,
  ciphertext: 'c2VjcmV0',
  sentAt: NOW,
  expiresAt: NOW + MESSAGE_TTL_SECONDS,
  ...over,
});

const stores: Array<[string, () => Store]> = [
  ['in memory', () => new MemoryStore(() => NOW)],
  // Two items per page, so anything longer than that only works if paging does.
  ['on DynamoDB (stand-in client)', () => new DynamoStore('table', new FakeDynamoDB(2))],
];

const ids = (messages: Envelope[]) => messages.map((m) => m.id);

describe.each(stores)('a store %s', (_name, newStore) => {
  describe('connections', () => {
    it('finds a connection by its id', async () => {
      const store = newStore();
      const connection = { connectionId: 'c1', deviceId: alice, connectedAt: NOW };
      await store.putConnection(connection);
      expect(await store.getConnection('c1')).toEqual(connection);
      expect(await store.getConnection('c2')).toBeUndefined();
    });

    it('lists every connection of a device, and only that device', async () => {
      const store = newStore();
      for (const id of ['c1', 'c2', 'c3']) {
        await store.putConnection({ connectionId: id, deviceId: alice, connectedAt: NOW });
      }
      await store.putConnection({ connectionId: 'c9', deviceId: bob, connectedAt: NOW });
      const listed = await store.listConnections(alice);
      expect(listed.map((c) => c.connectionId).sort()).toEqual(['c1', 'c2', 'c3']);
      expect(await store.listConnections(carol)).toEqual([]);
    });

    it('forgets a deleted connection in both directions', async () => {
      const store = newStore();
      await store.putConnection({ connectionId: 'c1', deviceId: alice, connectedAt: NOW });
      await store.putConnection({ connectionId: 'c2', deviceId: alice, connectedAt: NOW });
      await store.deleteConnection('c1');
      expect(await store.getConnection('c1')).toBeUndefined();
      expect((await store.listConnections(alice)).map((c) => c.connectionId)).toEqual(['c2']);
    });

    it('is not troubled by deleting a connection it does not have', async () => {
      const store = newStore();
      await expect(store.deleteConnection('nope')).resolves.toBeUndefined();
    });

    it('does not mistake a waiting message for a connection', async () => {
      const store = newStore();
      await store.putMessage(envelope({ to: alice, from: bob }));
      expect(await store.listConnections(alice)).toEqual([]);
    });
  });

  describe('messages', () => {
    it('lists what is addressed to a device, oldest first, however many there are', async () => {
      const store = newStore();
      // Ids chosen so that id order is the reverse of time order.
      for (let i = 0; i < 7; i++) {
        await store.putMessage(envelope({ id: `m${9 - i}`, sentAt: NOW + i, expiresAt: NOW + i + 100 }));
      }
      await store.putMessage(envelope({ id: 'other', to: carol }));
      expect(ids(await store.listMessages(bob, NOW + 10))).toEqual(['m9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3']);
    });

    it('never lists a message at or after its expiry', async () => {
      const store = newStore();
      await store.putMessage(envelope({ id: 'short', expiresAt: NOW + 10 }));
      await store.putMessage(envelope({ id: 'long', sentAt: NOW + 1, expiresAt: NOW + 20 }));
      expect(ids(await store.listMessages(bob, NOW + 9))).toEqual(['short', 'long']);
      expect(ids(await store.listMessages(bob, NOW + 10))).toEqual(['long']);
      expect(ids(await store.listMessages(bob, NOW + 20))).toEqual([]);
    });

    it('finds live messages even when whole pages before them have expired', async () => {
      const store = newStore();
      for (let i = 0; i < 5; i++) await store.putMessage(envelope({ id: `a${i}`, expiresAt: NOW + 1 }));
      await store.putMessage(envelope({ id: 'z', expiresAt: NOW + 100 }));
      expect(ids(await store.listMessages(bob, NOW + 5))).toEqual(['z']);
    });

    it('lets only the receiver delete a message', async () => {
      const store = newStore();
      await store.putMessage(envelope());
      await store.deleteMessage(alice, 'm1'); // the sender
      await store.deleteMessage(carol, 'm1'); // a stranger
      expect(ids(await store.listMessages(bob, NOW))).toEqual(['m1']);
      await store.deleteMessage(bob, 'm1');
      expect(await store.listMessages(bob, NOW)).toEqual([]);
      await expect(store.deleteMessage(bob, 'm1')).resolves.toBeUndefined(); // again: harmless
    });

    it('hands back exactly the envelope it was given', async () => {
      const store = newStore();
      await store.putMessage(envelope());
      await store.markDelivered(bob, 'm1');
      expect(await store.listMessages(bob, NOW)).toEqual([envelope()]);
    });
  });

  describe('delivered marks and taking back', () => {
    it('marks a message that exists, and refuses one that does not', async () => {
      const store = newStore();
      await store.putMessage(envelope());
      expect(await store.markDelivered(bob, 'm1')).toBe(true);
      expect(await store.markDelivered(bob, 'gone')).toBe(false);
      expect(await store.markDelivered(carol, 'm1')).toBe(false); // not addressed to carol
    });

    it('does not bring a deleted message back to life by marking it', async () => {
      const store = newStore();
      await store.putMessage(envelope());
      await store.deleteMessage(bob, 'm1');
      expect(await store.markDelivered(bob, 'm1')).toBe(false);
      expect(await store.listMessages(bob, NOW)).toEqual([]);
    });

    it('takes back one undelivered message by id', async () => {
      const store = newStore();
      await store.putMessage(envelope({ id: 'm1' }));
      await store.putMessage(envelope({ id: 'm2', sentAt: NOW + 1 }));
      await store.unsendMessages(alice, bob, 'm1');
      expect(ids(await store.listMessages(bob, NOW))).toEqual(['m2']);
    });

    it('takes back every undelivered message to one receiver, however many', async () => {
      const store = newStore();
      for (let i = 0; i < 5; i++) await store.putMessage(envelope({ id: `m${i}`, sentAt: NOW + i }));
      await store.putMessage(envelope({ id: 'toCarol', to: carol }));
      await store.unsendMessages(alice, bob);
      expect(await store.listMessages(bob, NOW)).toEqual([]);
      expect(ids(await store.listMessages(carol, NOW))).toEqual(['toCarol']);
    });

    it('leaves delivered messages alone, by id or all at once', async () => {
      const store = newStore();
      await store.putMessage(envelope({ id: 'delivered' }));
      await store.putMessage(envelope({ id: 'waiting', sentAt: NOW + 1 }));
      await store.markDelivered(bob, 'delivered');
      await store.unsendMessages(alice, bob, 'delivered');
      await store.unsendMessages(alice, bob);
      expect(ids(await store.listMessages(bob, NOW))).toEqual(['delivered']);
    });

    it('leaves other senders’ messages alone, by id or all at once', async () => {
      const store = newStore();
      await store.putMessage(envelope({ id: 'fromCarol', from: carol }));
      await store.unsendMessages(alice, bob, 'fromCarol');
      await store.unsendMessages(alice, bob);
      expect(ids(await store.listMessages(bob, NOW))).toEqual(['fromCarol']);
    });

    it('is not troubled by taking back what is not there', async () => {
      const store = newStore();
      await expect(store.unsendMessages(alice, bob, 'nope')).resolves.toBeUndefined();
      await expect(store.unsendMessages(alice, bob)).resolves.toBeUndefined();
    });
  });

  describe('through the router', () => {
    const send = (to: string) => JSON.stringify({ action: 'send', to, ciphertext: 'c2VjcmV0' });
    const frame = (action: object) => JSON.stringify(action);

    function world() {
      const clock = { now: NOW };
      const posted: Array<{ connectionId: string; event: ServerEvent }> = [];
      let nextId = 1;
      const deps: Deps = {
        store: newStore(),
        now: () => clock.now,
        newId: () => `m${nextId++}`,
        messageTtlSeconds: MESSAGE_TTL_SECONDS,
        transport: {
          async post(connectionId, event) {
            posted.push({ connectionId, event });
            return true;
          },
        },
      };
      const received = (connectionId: string) =>
        posted.flatMap((p) =>
          p.connectionId === connectionId && p.event.type === 'message' ? [p.event.envelope.id] : [],
        );
      return { deps, clock, posted, received };
    }

    it('keeps messages for someone offline and hands them over on fetch, then forgets them on ack', async () => {
      const { deps, received } = world();
      await onConnect(deps, 'a', alice);
      for (let i = 0; i < 5; i++) await onMessage(deps, 'a', send(bob));

      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'b', frame({ action: 'fetch' }));
      expect(received('b')).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

      for (const id of received('b')) await onMessage(deps, 'b', frame({ action: 'ack', messageId: id }));
      await onDisconnect(deps, 'b');
      await onConnect(deps, 'b2', bob);
      await onMessage(deps, 'b2', frame({ action: 'fetch' }));
      expect(received('b2')).toEqual([]);
    });

    it('pushes to a receiver who connected a moment before the message was sent', async () => {
      const { deps, received } = world();
      await onConnect(deps, 'a', alice);
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'b', frame({ action: 'fetch' })); // nothing yet
      await onMessage(deps, 'a', send(bob));
      expect(received('b')).toEqual(['m1']);
    });

    it('takes back what was not delivered, and only that', async () => {
      const { deps, received } = world();
      await onConnect(deps, 'a', alice);
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'a', send(bob)); // m1, delivered live
      await onDisconnect(deps, 'b');
      await onMessage(deps, 'a', send(bob)); // m2, waiting
      await onMessage(deps, 'a', send(bob)); // m3, waiting
      await onMessage(deps, 'a', frame({ action: 'unsend', to: bob }));

      await onConnect(deps, 'b2', bob);
      await onMessage(deps, 'b2', frame({ action: 'fetch' }));
      expect(received('b2')).toEqual(['m1']); // delivered but never acknowledged: it comes again
    });

    it('never delivers after 24 hours', async () => {
      const { deps, clock, received } = world();
      await onConnect(deps, 'a', alice);
      await onMessage(deps, 'a', send(bob));
      clock.now += MESSAGE_TTL_SECONDS;
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'b', frame({ action: 'fetch' }));
      expect(received('b')).toEqual([]);
    });
  });
});

describe('the DynamoDB store, specifically', () => {
  it('writes both halves of a connection in one transaction, and removes both in one', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putConnection({ connectionId: 'c1', deviceId: alice, connectedAt: NOW });
    expect(db.calls).toEqual(['TransactWriteCommand']);
    expect(db.items.size).toBe(2);
    await store.deleteConnection('c1');
    expect(db.items.size).toBe(0);
  });

  it('acknowledges with a single delete, no read first', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putMessage(envelope());
    db.calls.length = 0;
    await store.deleteMessage(bob, 'm1');
    expect(db.calls).toEqual(['DeleteCommand']);
  });

  it('leaves nothing in the table once a message is acknowledged or taken back', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putMessage(envelope({ id: 'm1' }));
    await store.putMessage(envelope({ id: 'm2' }));
    await store.markDelivered(bob, 'm1');
    await store.deleteMessage(bob, 'm1');
    await store.unsendMessages(alice, bob, 'm2');
    expect(db.items.size).toBe(0);
  });

  it('never reads an index, so every read can be strongly consistent', async () => {
    const db = new FakeDynamoDB();
    const send = db.send.bind(db);
    const inputs: any[] = [];
    db.send = async (command) => (inputs.push(command.input), send(command));
    const store = new DynamoStore('table', db);
    await store.putConnection({ connectionId: 'c1', deviceId: alice, connectedAt: NOW });
    await store.getConnection('c1');
    await store.listConnections(alice);
    await store.listMessages(alice, NOW);
    await store.unsendMessages(alice, bob);
    const reads = inputs.filter((input) => 'Key' in input === false && 'KeyConditionExpression' in input);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.IndexName).toBeUndefined();
      expect(read.ConsistentRead).toBe(true);
    }
  });
});
