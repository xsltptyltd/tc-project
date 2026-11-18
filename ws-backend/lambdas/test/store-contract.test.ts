// What every Store must do, run against each implementation: the in-memory one, and the
// DynamoDB one talking to an in-memory stand-in for the DynamoDB client. The second half
// runs whole conversations through the router on each, so the two cannot drift apart.
import { describe, expect, it } from 'vitest';
import { INVITATION_TTL_SECONDS, MESSAGE_TTL_SECONDS, type Envelope, type ServerEvent } from 'tc-protocol';
import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { contactItem, DynamoStore } from '../src/adapters/dynamodb-store';
import { MemoryStore } from '../src/adapters/memory-store';
import { onConnect, onDisconnect } from '../src/core/connections';
import type { ContactStore, Deps, Store } from '../src/core/ports';
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

const stores: Array<[string, () => Store & ContactStore]> = [
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

    it('deletes everything between two devices, both ways, delivered or not, and nothing else', async () => {
      const store = newStore();
      await store.putMessage(envelope({ id: 'a-to-b', from: alice, to: bob }));
      await store.putMessage(envelope({ id: 'b-to-a', from: bob, to: alice }));
      await store.putMessage(envelope({ id: 'seen', from: alice, to: bob, sentAt: NOW + 1 }));
      await store.putMessage(envelope({ id: 'c-to-b', from: carol, to: bob }));
      await store.putMessage(envelope({ id: 'a-to-c', from: alice, to: carol }));
      for (let i = 0; i < 5; i++) await store.putMessage(envelope({ id: `many${i}`, from: bob, to: alice, sentAt: NOW + i }));
      await store.markDelivered(bob, 'seen');

      await store.deleteMessagesBetween(bob, alice);
      expect(ids(await store.listMessages(bob, NOW))).toEqual(['c-to-b']);
      expect(await store.listMessages(alice, NOW)).toEqual([]);
      expect(ids(await store.listMessages(carol, NOW))).toEqual(['a-to-c']);
      await expect(store.deleteMessagesBetween(bob, alice)).resolves.toBeUndefined(); // again: harmless
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

    const token = (n: number) => String(n).padStart(43, 'T');
    const mac = 'M'.repeat(43);

    /** One store holds everything — messages, connections, invitations, contacts. */
    async function world({ strangers = false } = {}) {
      const clock = { now: NOW };
      const posted: Array<{ connectionId: string; event: ServerEvent }> = [];
      let nextId = 1;
      const store = newStore();
      const deps: Deps = {
        store,
        now: () => clock.now,
        newId: () => `m${nextId++}`,
        messageTtlSeconds: MESSAGE_TTL_SECONDS,
        contacts: store,
        invitationTtlSeconds: INVITATION_TTL_SECONDS,
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
      const answers = (connectionId: string) => posted.filter((p) => p.connectionId === connectionId).map((p) => p.event);
      // alice and bob are contacts the only way there is: an invitation, accepted.
      if (!strangers) {
        await store.putInvitation({ tokenId: token(0), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
        await store.acceptInvitation(token(0), { inviter: alice, invitee: bob }, NOW);
      }
      return { deps, store, clock, posted, received, answers };
    }

    it('keeps messages for someone offline and hands them over on fetch, then forgets them on ack', async () => {
      const { deps, received } = await world();
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
      const { deps, received } = await world();
      await onConnect(deps, 'a', alice);
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'b', frame({ action: 'fetch' })); // nothing yet
      await onMessage(deps, 'a', send(bob));
      expect(received('b')).toEqual(['m1']);
    });

    it('takes back what was not delivered, and only that', async () => {
      const { deps, received } = await world();
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
      const { deps, clock, received } = await world();
      await onConnect(deps, 'a', alice);
      await onMessage(deps, 'a', send(bob));
      clock.now += MESSAGE_TTL_SECONDS;
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'b', frame({ action: 'fetch' }));
      expect(received('b')).toEqual([]);
    });

    it('lets two strangers write only once one has accepted the other’s invitation', async () => {
      const { deps, answers, received } = await world({ strangers: true });
      await onConnect(deps, 'a', alice);
      await onConnect(deps, 'b', bob);
      await onMessage(deps, 'a', send(bob));
      expect(answers('a')).toEqual([{ type: 'error', code: 'not_a_contact' }]);

      await onMessage(deps, 'a', frame({ action: 'invite', tokenId: token(1), initials: 'AZ' }));
      await onMessage(deps, 'b', frame({ action: 'accept', tokenId: token(1), inviter: alice, initials: 'BB', mac }));
      expect(answers('b')).toEqual([{ type: 'accepted', inviter: alice, initials: 'AZ' }]);
      expect(answers('a').at(-1)).toEqual({ type: 'invitee', tokenId: token(1), invitee: bob, initials: 'BB', mac });

      await onMessage(deps, 'a', send(bob));
      await onMessage(deps, 'b', send(alice));
      expect(received('b')).toHaveLength(1);
      expect(received('a')).toHaveLength(1);
    });

    it('lets an invitation be accepted once, and not after it expires', async () => {
      const { deps, clock, answers } = await world({ strangers: true });
      await onConnect(deps, 'a', alice);
      await onConnect(deps, 'b', bob);
      await onConnect(deps, 'c', carol);
      await onMessage(deps, 'a', frame({ action: 'invite', tokenId: token(1), initials: 'AZ' }));
      await onMessage(deps, 'a', frame({ action: 'invite', tokenId: token(2), initials: 'AZ' }));
      await onMessage(deps, 'b', frame({ action: 'accept', tokenId: token(1), inviter: alice, initials: 'BB', mac }));
      await onMessage(deps, 'c', frame({ action: 'accept', tokenId: token(1), inviter: alice, initials: 'CC', mac }));
      clock.now += INVITATION_TTL_SECONDS;
      await onMessage(deps, 'c', frame({ action: 'accept', tokenId: token(2), inviter: alice, initials: 'CC', mac }));
      expect(answers('c')).toEqual([
        { type: 'error', code: 'invitation_invalid' },
        { type: 'error', code: 'invitation_invalid' },
      ]);
      await onMessage(deps, 'c', send(alice));
      expect(answers('c').at(-1)).toEqual({ type: 'error', code: 'not_a_contact' });
    });

    it('ends a contact for both, deletes what was waiting, tells both sides, and the lists agree', async () => {
      const { deps, answers, received } = await world();
      await onConnect(deps, 'a', alice);
      for (let i = 0; i < 3; i++) await onMessage(deps, 'a', send(bob)); // bob offline: waiting
      await onConnect(deps, 'b', bob);
      await onConnect(deps, 'b2', bob);

      await onMessage(deps, 'b', frame({ action: 'remove', contact: alice }));
      expect(answers('b').at(-1)).toEqual({ type: 'contact_removed', contact: alice });
      expect(answers('b')).toContainEqual({ type: 'removed', contact: alice });
      expect(answers('b2')).toEqual([{ type: 'contact_removed', contact: alice }]);
      expect(answers('a').at(-1)).toEqual({ type: 'contact_removed', contact: bob });

      await onMessage(deps, 'b', frame({ action: 'fetch' }));
      expect(received('b')).toEqual([]); // the three waiting messages are gone
      await onMessage(deps, 'a', frame({ action: 'contacts' }));
      await onMessage(deps, 'b', frame({ action: 'contacts' }));
      expect(answers('a').at(-1)).toEqual({ type: 'contacts', contacts: [] });
      expect(answers('b').at(-1)).toEqual({ type: 'contacts', contacts: [] });
      await onMessage(deps, 'a', send(bob));
      expect(answers('a').at(-1)).toEqual({ type: 'error', code: 'not_a_contact' });
    });

    it('lists every contact of a device, however many', async () => {
      const { deps, store, answers } = await world({ strangers: true });
      const friends = Array.from({ length: 7 }, () => newDevice().deviceId);
      for (const [i, friend] of friends.entries()) {
        await store.putInvitation({ tokenId: token(10 + i), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
        await store.acceptInvitation(token(10 + i), { inviter: alice, invitee: friend }, NOW);
      }
      await onConnect(deps, 'a', alice);
      await onMessage(deps, 'a', frame({ action: 'contacts' }));
      const [answer] = answers('a');
      expect(answer?.type === 'contacts' && [...answer.contacts].sort()).toEqual([...friends].sort());
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
    const commands: Array<{ name: string; input: any }> = [];
    db.send = async (command) => (commands.push({ name: command.constructor.name, input: command.input }), send(command));
    const store = new DynamoStore('table', db);
    await store.putConnection({ connectionId: 'c1', deviceId: alice, connectedAt: NOW });
    await store.getConnection('c1');
    await store.listConnections(alice);
    await store.listMessages(alice, NOW);
    await store.unsendMessages(alice, bob);
    await store.deleteMessagesBetween(alice, bob);
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW);
    await store.isContact(alice, bob);
    await store.listContacts(alice);
    const reads = commands.filter((c) => c.name === 'QueryCommand' || c.name === 'GetCommand');
    expect(new Set(reads.map((r) => r.name))).toEqual(new Set(['QueryCommand', 'GetCommand']));
    for (const { input } of reads) {
      expect(input.IndexName).toBeUndefined();
      expect(input.ConsistentRead).toBe(true);
    }
  });

  it('accepts an invitation with one read and one transaction: taken, and both sides written', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    db.calls.length = 0;
    const send = db.send.bind(db);
    let transaction: any;
    db.send = async (command) => {
      if (command.constructor.name === 'TransactWriteCommand') transaction = command.input;
      return send(command);
    };
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW);
    expect(db.calls).toEqual(['GetCommand', 'TransactWriteCommand']);
    expect(transaction.TransactItems.map((t: object) => Object.keys(t)[0])).toEqual(['Update', 'Put', 'Put']);
  });

  it('refuses a bad acceptance without a transaction, from the read alone', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    db.calls.length = 0;
    await store.acceptInvitation('U'.repeat(43), { inviter: alice, invitee: bob }, NOW); // unknown
    await store.acceptInvitation('T'.repeat(43), { inviter: carol, invitee: bob }, NOW); // not carol's
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW + 20); // expired
    expect(db.calls).toEqual(['GetCommand', 'GetCommand', 'GetCommand']);
  });

  it('removes a contact in one transaction, and leaves nothing of it in the table', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW);
    expect([...db.items.keys()].filter((k) => k.includes('CONTACT#'))).toHaveLength(2);
    db.calls.length = 0;
    await store.removeContact(alice, bob);
    expect(db.calls).toEqual(['TransactWriteCommand']);
    expect([...db.items.keys()].filter((k) => k.includes('CONTACT#'))).toEqual([]);
  });

  it('keeps an accepted invitation only until DynamoDB’s TTL takes it, like any invitation', async () => {
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW);
    const invitation = db.items.get(`INVITATION#${'T'.repeat(43)}|INVITATION`);
    expect(invitation).toMatchObject({ acceptedBy: bob, ttl: NOW + 20 });
    expect(JSON.stringify(invitation)).not.toContain('BB'); // the invitee's initials: relayed, never stored
  });

  it("answers from the owner's own record — the one in its partition", async () => {
    // Only one side in the table, as could only happen by hand: the reads must still mean
    // "my contacts", not "who has me".
    const db = new FakeDynamoDB();
    const store = new DynamoStore('table', db);
    await db.send(new PutCommand({ TableName: 'table', Item: contactItem(alice, bob) }));
    expect(await store.isContact(alice, bob)).toBe(true);
    expect(await store.isContact(bob, alice)).toBe(false);
    expect(await store.listContacts(alice)).toEqual([bob]);
    expect(await store.listContacts(bob)).toEqual([]);
  });

  it('does not mistake a contact for a connection or a message in the same partition', async () => {
    const store = new DynamoStore('table', new FakeDynamoDB());
    await store.putInvitation({ tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: NOW + 20 });
    await store.acceptInvitation('T'.repeat(43), { inviter: alice, invitee: bob }, NOW);
    await store.putConnection({ connectionId: 'c1', deviceId: alice, connectedAt: NOW });
    await store.putMessage(envelope({ from: bob, to: alice }));
    expect((await store.listConnections(alice)).map((c) => c.connectionId)).toEqual(['c1']);
    expect(ids(await store.listMessages(alice, NOW))).toEqual(['m1']);
    expect(await store.listContacts(alice)).toEqual([bob]);
  });
});

// The stand-in is only worth its tests if it fails where DynamoDB fails.
describe('the stand-in DynamoDB client', () => {
  const put = (Item: object, ConditionExpression?: string) =>
    new PutCommand({ TableName: 't', Item: Item as Record<string, unknown>, ConditionExpression });

  it('refuses a conditional put, as DynamoDB does', async () => {
    const db = new FakeDynamoDB();
    await db.send(put({ PK: 'a', SK: 'b' }));
    await expect(db.send(put({ PK: 'a', SK: 'b', x: 1 }, 'attribute_not_exists(PK)'))).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    expect(db.items.get('a|b')).toEqual({ PK: 'a', SK: 'b' });
  });

  it('cancels a whole transaction when one condition fails, with a reason per item, writing nothing', async () => {
    const db = new FakeDynamoDB();
    const attempt = db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: 't', Item: { PK: 'x', SK: '1' } } },
          {
            Update: {
              TableName: 't',
              Key: { PK: 'y', SK: '1' },
              UpdateExpression: 'SET #v = :v',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeNames: { '#v': 'v' },
              ExpressionAttributeValues: { ':v': 1 },
            },
          },
        ],
      }),
    );
    await expect(attempt).rejects.toMatchObject({
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    expect(db.items.size).toBe(0);
  });

  it('refuses two writes to one item in a transaction, and a reserved word used bare', async () => {
    const db = new FakeDynamoDB();
    const twice = new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: 't', Item: { PK: 'x', SK: '1' } } },
        { Delete: { TableName: 't', Key: { PK: 'x', SK: '1' } } },
      ],
    });
    await expect(db.send(twice)).rejects.toMatchObject({ name: 'ValidationException' });
    await expect(db.send(put({ PK: 'a', SK: 'b' }, 'attribute_not_exists(owner)'))).rejects.toThrow('reserved word');
  });
});
