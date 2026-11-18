// Two clients talking through the local server: the whole path, on one machine.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  encryptFor,
  generateIdentity,
  init,
  invitationKey,
  invitationMac,
  invitationTokenId,
  newInvitationSecret,
  type Identity,
} from 'tc-crypto';
import { startLocalServer, type LocalServer } from '../../ws-backend/lambdas/local/server';
import {
  ContactList,
  MemoryContactBook,
  NotAContact,
  ProximityUnavailable,
  REMEMBERED_IDS,
  REQUEST_TIMEOUT_MS,
  ServerError,
  TcClient,
  textInvitationCodec,
  type IncomingMessage,
  type Contact,
  type Proximity,
} from '../src';

let server: LocalServer;
const clients: TcClient[] = [];

// Each identity's own contact book, as its device would keep it across connections.
const books = new Map<string, MemoryContactBook>();
const bookOf = (identity: Identity) =>
  books.get(identity.deviceId) ?? books.set(identity.deviceId, new MemoryContactBook()).get(identity.deviceId)!;

/** A client for `identity`, with that identity's contact book. */
function clientFor(identity: Identity, url = server.url): TcClient {
  return new TcClient(identity, url, bookOf(identity));
}

async function connect(identity = generateIdentity()) {
  const client = clientFor(identity);
  clients.push(client);
  await client.connect();
  return { client, identity };
}

/**
 * Makes two devices contacts, as an accepted invitation would: on the server (D19), and
 * in each one's own contact book (D20). The invitation tests do it for real.
 */
function befriend(a: Identity, b: Identity) {
  server.store.addContact(a.deviceId, b.deviceId);
  void bookOf(a).put({ deviceId: b.deviceId, initials: 'XX', label: 'XX' });
  void bookOf(b).put({ deviceId: a.deviceId, initials: 'XX', label: 'XX' });
}

/** Two devices side by side, as far as the test is concerned: they share `value`. */
function sideBySide(value: string): Proximity {
  return { announce: async () => ({ value, stop() {} }), sense: async () => value };
}
const together = sideBySide('room 1');

/** Only in the two devices' own books, as when there is no real server to tell. */
function befriendLocally(a: Identity, b: Identity) {
  void bookOf(a).put({ deviceId: b.deviceId, initials: 'XX', label: 'XX' });
  void bookOf(b).put({ deviceId: a.deviceId, initials: 'XX', label: 'XX' });
}

const nextMessage = (client: TcClient) =>
  new Promise<IncomingMessage>((resolve) => client.onMessage(resolve));

beforeAll(() => init());
beforeEach(async () => {
  books.clear();
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
    befriend(alice.identity, bob.identity);
    const received = nextMessage(bob.client);

    const receipt = await alice.client.send(bob.identity.deviceId, 'see you at 8');

    expect(await received).toEqual({
      id: receipt.messageId,
      from: alice.identity.deviceId,
      name: 'XX',
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
    befriend(alice.identity, bob);

    const receipt = await alice.client.send(bob.deviceId, 'are you there?');

    expect(receipt).toEqual({ messageId: receipt.messageId });
    expect(server.store.messages.has(receipt.messageId)).toBe(true);
  });

  it('delivers messages sent while the receiver was offline once it connects', async () => {
    const alice = await connect();
    const bob = generateIdentity();
    befriend(alice.identity, bob);
    await alice.client.send(bob.deviceId, 'first');
    await alice.client.send(bob.deviceId, 'second');

    const bobClient = clientFor(bob);
    clients.push(bobClient);
    const received: string[] = [];
    bobClient.onMessage((m) => received.push(`${m.from === alice.identity.deviceId ? 'alice' : '?'}: ${m.text}`));
    await bobClient.connect();

    await expect.poll(() => received).toEqual(['alice: first', 'alice: second']);
  });

  it('delivers to a receiver that is already online straight away, once', async () => {
    const alice = await connect();
    const bob = await connect();
    befriend(alice.identity, bob.identity);
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
    befriend(alice.identity, bob.identity);
    const received = nextMessage(bob.client);

    const receipt = await alice.client.send(bob.identity.deviceId, 'read once');
    await received;

    await expect.poll(() => server.store.messages.has(receipt.messageId)).toBe(false);
  });

  it('does not deliver a message again to someone joining a second time', async () => {
    const alice = await connect();
    const bob = generateIdentity();
    befriend(alice.identity, bob);
    await alice.client.send(bob.deviceId, 'only once');

    const first = clientFor(bob);
    clients.push(first);
    const firstTime: string[] = [];
    first.onMessage((m) => firstTime.push(m.text));
    await first.connect();
    await expect.poll(() => firstTime).toEqual(['only once']);
    await first.close();

    const second = clientFor(bob);
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
    befriend(alice.identity, bob);

    await alice.client.send(bob.deviceId, 'too late');
    // Nobody asks for it: only the server's sweeper can remove it.
    await expect.poll(() => server.store.messages.size, { timeout: 3000 }).toBe(0);

    const late = clientFor(bob);
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
    befriend(alice.identity, bob);
    await alice.client.send(bob.deviceId, 'forget this');
    await alice.client.send(bob.deviceId, 'and this');

    alice.client.unsend(bob.deviceId);
    await expect.poll(() => server.store.messages.size).toBe(0);

    const late = clientFor(bob);
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
    befriend(alice.identity, bob.identity);

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
    befriend(alice.identity, bob.identity);
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

describe('contacts and invitations, end to end', () => {
  const notAContact = new ServerError('not_a_contact');

  it('does not let two devices that never met write to each other', async () => {
    const alice = await connect();
    const charlie = await connect();
    const received: string[] = [];
    charlie.client.onMessage((m) => received.push(m.text));

    // Refused on each device before anything is encrypted (D20)…
    await expect(alice.client.send(charlie.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    await expect(charlie.client.send(alice.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    expect(server.store.messages.size).toBe(0);
    expect(received).toEqual([]);
  });

  it('is refused by the backend too, even for a device whose own book says otherwise', async () => {
    const alice = await connect();
    const charlie = await connect();
    befriendLocally(alice.identity, charlie.identity); // but never met: not on the server
    await expect(alice.client.send(charlie.identity.deviceId, 'hi')).rejects.toEqual(notAContact);
    expect(server.store.messages.size).toBe(0);
  });

  it('lets two people side by side exchange keys and initials with a code, checked by the MAC', async () => {
    const alice = await connect();
    const bob = await connect();
    const invitee = new Promise<Contact>((resolve) => alice.client.onInvitee(resolve));

    const open = await alice.client.invite('AZ', together);
    expect(open.expiresIn).toBe(20);
    // What alice shows, and what bob reads: here text, on a phone a QR code.
    const read = textInvitationCodec.decode(textInvitationCodec.encode(open.invitation))!;
    const inviter = await bob.client.accept(read, 'BB', together);

    expect(inviter).toEqual({ deviceId: alice.identity.deviceId, initials: 'AZ', label: 'AZ' });
    expect(await invitee).toEqual({ deviceId: bob.identity.deviceId, initials: 'BB', label: 'BB' });
    // Each now trusts exactly the other's key: bob's from the code, alice's from the MAC.
    expect([...bookOf(alice.identity).contacts.values()]).toEqual([await invitee]);
    expect([...bookOf(bob.identity).contacts.values()]).toEqual([inviter]);
    // The backend never had the secret.
    expect(JSON.stringify([...server.store.invitations.values()])).not.toContain(open.invitation.secret);
  });

  it('makes the two contacts, who can then write to each other both ways — and only them', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    const { invitation } = await alice.client.invite('AZ', together);
    await bob.client.accept(invitation, 'BB', together);

    const toAlice = nextMessage(alice.client);
    await bob.client.send(alice.identity.deviceId, 'hi AZ');
    expect(await toAlice).toMatchObject({ from: bob.identity.deviceId, name: 'BB', text: 'hi AZ' });
    const toBob = nextMessage(bob.client);
    await alice.client.send(bob.identity.deviceId, 'hi BB');
    expect((await toBob).text).toBe('hi BB');

    await expect(carol.client.send(alice.identity.deviceId, 'me too?')).rejects.toThrow(NotAContact);
  });

  it('refuses a code accepted from another room, without using it up', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    const { invitation } = await alice.client.invite('AZ', sideBySide('room 1'));

    await expect(carol.client.accept(invitation, 'CC', sideBySide('room 2'))).rejects.toEqual(
      new ServerError('invitation_invalid'),
    );
    await expect(carol.client.send(alice.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    // The real invitee, in the room, still can.
    await expect(bob.client.accept(invitation, 'BB', sideBySide('room 1'))).resolves.toMatchObject({
      initials: 'AZ',
    });
  });

  it('shows no invitation, and registers nothing, when the inviter cannot announce proximity', async () => {
    const alice = await connect();
    const nowhere: Proximity = {
      announce: () => Promise.reject(new ProximityUnavailable('Bluetooth is off')),
      sense: () => Promise.reject(new ProximityUnavailable('Bluetooth is off')),
    };
    await expect(alice.client.invite('AZ', nowhere)).rejects.toThrow(ProximityUnavailable);
    expect(server.store.invitations.size).toBe(0);
  });

  it('fails an acceptance without proximity before it reaches the backend, so it can be retried', async () => {
    const alice = await connect();
    const bob = await connect();
    const { invitation } = await alice.client.invite('AZ', together);
    const notYet: Proximity = { ...together, sense: () => Promise.reject(new ProximityUnavailable('no room')) };

    await expect(bob.client.accept(invitation, 'BB', notYet)).rejects.toThrow(ProximityUnavailable);
    expect([...server.store.invitations.values()][0]?.acceptedBy).toBeUndefined();
    await expect(bob.client.accept(invitation, 'BB', together)).resolves.toBeDefined();
  });

  it('stops announcing once the invitation is accepted, or closed', async () => {
    const alice = await connect();
    const bob = await connect();
    const stopped: string[] = [];
    const tracked = (value: string): Proximity => ({
      announce: async () => ({ value, stop: () => stopped.push(value) }),
      sense: async () => value,
    });
    const accepted = new Promise<Contact>((resolve) => alice.client.onInvitee(resolve));

    const first = await alice.client.invite('AZ', tracked('first'));
    await bob.client.accept(first.invitation, 'BB', tracked('first'));
    await accepted;
    expect(stopped).toEqual(['first']);

    const second = await alice.client.invite('AZ', tracked('second'));
    second.close();
    expect(stopped).toEqual(['first', 'second']);
  });

  it('keeps a corrupted server out of the middle: a swapped key is caught, never trusted, never used', async () => {
    // The server as alice sees it: everything relayed, except that whoever accepts her
    // invitation is replaced by mallory — the server's own key — and mallory then writes
    // to her as the new contact.
    const mallory = generateIdentity();
    const aliceIdentity = generateIdentity();
    const aliceId = aliceIdentity.deviceId;
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => relay.once('listening', resolve));
    relay.on('connection', (down, request) => {
      const up = new WebSocket(server.url + request.url);
      const early: string[] = [];
      up.on('open', () => early.splice(0).forEach((frame) => up.send(frame)));
      down.on('message', (data) => (up.readyState === up.OPEN ? up.send(data.toString()) : early.push(data.toString())));
      down.on('close', () => up.close());
      up.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type !== 'invitee') return down.send(data.toString());
        down.send(JSON.stringify({ ...event, invitee: mallory.deviceId }));
        const ciphertext = encryptFor(mallory, aliceId, { v: 1, text: 'it is me, bob' });
        down.send(JSON.stringify({
          type: 'message',
          envelope: { id: 'x1', from: mallory.deviceId, to: aliceId, ciphertext, sentAt: 0, expiresAt: 9e9 },
        }));
      });
    });
    try {
      const alice = clientFor(aliceIdentity, `ws://127.0.0.1:${(relay.address() as { port: number }).port}`);
      clients.push(alice);
      const shown: string[] = [];
      const verified: Contact[] = [];
      const forged = new Promise<void>((resolve) => alice.onForgedInvitee(resolve));
      alice.onMessage((m) => shown.push(m.text));
      alice.onInvitee((invitee) => verified.push(invitee));
      await alice.connect();
      const bob = await connect();

      const { invitation } = await alice.invite('AZ', together);
      await bob.client.accept(invitation, 'BB', together);
      await forged; // alice is told

      expect(verified).toEqual([]);
      expect(bookOf(aliceIdentity).contacts.size).toBe(0);
      // Nothing is ever encrypted to the server's key, and nothing from it is shown.
      await expect(alice.send(mallory.deviceId, 'secret plans')).rejects.toThrow(NotAContact);
      await alice.send(aliceId, 'flush').catch(() => {}); // one more round trip
      expect(shown).toEqual([]);
    } finally {
      for (const socket of relay.clients) socket.terminate();
      await new Promise((resolve) => relay.close(resolve));
    }
  });

  it('numbers people with the same initials in each list, and shows a message under its alias', async () => {
    const alice = await connect();
    const [bob, betty] = [await connect(), await connect()];
    const meet = async (invitee: typeof bob, initials: string) => {
      const added = new Promise<Contact>((resolve) => alice.client.onInvitee(resolve));
      const { invitation } = await alice.client.invite('AB', together);
      const inviter = await invitee.client.accept(invitation, initials, together);
      return { forAlice: await added, forThem: inviter };
    };
    const first = await meet(bob, 'BB');
    const second = await meet(betty, 'BB');
    expect([first.forAlice.label, second.forAlice.label]).toEqual(['BB', 'BB2']);
    expect([first.forThem.label, second.forThem.label]).toEqual(['AB', 'AB']); // their own lists

    await new ContactList(bookOf(alice.identity)).setAlias(betty.identity.deviceId, 'Betty');
    const received = nextMessage(alice.client);
    await betty.client.send(alice.identity.deviceId, 'hi');
    expect(await received).toMatchObject({ name: 'Betty', text: 'hi' });
  });

  it('lets an invitation be accepted once', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    const { invitation } = await alice.client.invite('AZ', together);
    await bob.client.accept(invitation, 'BB', together);
    await expect(carol.client.accept(invitation, 'CC', together)).rejects.toEqual(
      new ServerError('invitation_invalid'),
    );
  });

  it('stops working when its lifetime, set on the server, is over', async () => {
    await server.close();
    server = await startLocalServer(0, '127.0.0.1', { invitationTtlSeconds: 1 });
    const alice = await connect();
    const bob = await connect();
    const open = await alice.client.invite('AZ', together);
    expect(open.expiresIn).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(bob.client.accept(open.invitation, 'BB', together)).rejects.toThrow('invitation_invalid');
    // Refused on read at once; deleted by the sweeper on its next round.
    await expect.poll(() => server.store.invitations.size, { timeout: 3000 }).toBe(0);
  });

  it('does not let a device accept its own invitation', async () => {
    const alice = await connect();
    const { invitation } = await alice.client.invite('AZ', together);
    await expect(alice.client.accept(invitation, 'AZ', together)).rejects.toThrow('your own invitation');
  });

  it('refuses initials the backend would refuse, before sending anything', async () => {
    const alice = await connect();
    await expect(alice.client.invite('az', together)).rejects.toThrow();
    await expect(alice.client.invite('ABCDE', together)).rejects.toThrow();
    expect(server.store.invitations.size).toBe(0);
  });
});

describe('removing a contact, end to end', () => {
  /** alice and bob, connected, contacts for real: met through an invitation. */
  async function aliceAndBob() {
    const alice = await connect();
    const bob = await connect();
    const added = new Promise<Contact>((resolve) => alice.client.onInvitee(resolve));
    const { invitation } = await alice.client.invite('AZ', together);
    await bob.client.accept(invitation, 'BB', together);
    await added;
    return { alice, bob };
  }

  it('drops it from both lists at once when both are connected, and neither can write', async () => {
    const { alice, bob } = await aliceAndBob();
    const droppedByBob = new Promise<string>((resolve) => bob.client.onContactRemoved(resolve));

    await alice.client.removeContact(bob.identity.deviceId);

    expect(await droppedByBob).toBe(alice.identity.deviceId);
    expect(bookOf(alice.identity).contacts.size).toBe(0);
    expect(bookOf(bob.identity).contacts.size).toBe(0);
    await expect(alice.client.send(bob.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    await expect(bob.client.send(alice.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    expect(await server.store.isContact(alice.identity.deviceId, bob.identity.deviceId)).toBe(false);
  });

  it('drops it from the other list when that device next connects, if it was offline', async () => {
    const { alice, bob } = await aliceAndBob();
    await bob.client.close();
    await alice.client.removeContact(bob.identity.deviceId);
    expect(bookOf(bob.identity).contacts.size).toBe(1); // bob's device has not heard yet

    const later = clientFor(bob.identity);
    clients.push(later);
    await later.connect();
    await later.syncContacts();
    expect(bookOf(bob.identity).contacts.size).toBe(0);
  });

  it('follows a removal of one contact among several, but not a list that lost them all', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    befriend(alice.identity, bob.identity);
    befriend(alice.identity, carol.identity);

    // Bob removed alice while she was not looking: one of two, followed.
    await server.store.removeContact(alice.identity.deviceId, bob.identity.deviceId);
    expect(await alice.client.syncContacts()).toBe('synced');
    expect([...bookOf(alice.identity).contacts.keys()]).toEqual([carol.identity.deviceId]);

    // The server has lost everything (a restart, another table): all of several, refused.
    befriend(alice.identity, bob.identity);
    server.store.contacts.clear();
    expect(await alice.client.syncContacts()).toBe('refused');
    expect(bookOf(alice.identity).contacts.size).toBe(2);
  });

  it('leaves nobody with half a contact when the inviter never saw the acceptance', async () => {
    const alice = await connect();
    const bob = await connect();
    const dropped: string[] = [];
    bob.client.onContactRemoved((id) => dropped.push(id));
    const { invitation } = await alice.client.invite('AZ', together);
    await alice.client.close(); // her connection drops while the code is showing
    await bob.client.accept(invitation, 'BB', together);
    await bob.client.send(alice.identity.deviceId, 'hello?'); // nobody will ever show this
    expect(bookOf(alice.identity).contacts.size).toBe(0);
    expect(await server.store.isContact(alice.identity.deviceId, bob.identity.deviceId)).toBe(true);

    // Alice's device, back, finds a contact it never checked, and ends it for both.
    const later = clientFor(alice.identity);
    clients.push(later);
    await later.connect();
    expect(await later.syncContacts()).toBe('synced');
    expect(await server.store.isContact(alice.identity.deviceId, bob.identity.deviceId)).toBe(false);
    expect(server.store.messages.size).toBe(0);
    await expect.poll(() => bookOf(bob.identity).contacts.size).toBe(0);
    expect(dropped).toEqual([alice.identity.deviceId]);
  });

  it('deletes what was waiting between them, so it never arrives', async () => {
    const { alice, bob } = await aliceAndBob();
    await bob.client.close();
    await alice.client.send(bob.identity.deviceId, 'for later');
    expect(server.store.messages.size).toBe(1);
    await alice.client.removeContact(bob.identity.deviceId);
    expect(server.store.messages.size).toBe(0);
  });

  it('keeps nothing: meeting again gives a fresh label and no alias', async () => {
    const { alice, bob } = await aliceAndBob();
    await new ContactList(bookOf(alice.identity)).setAlias(bob.identity.deviceId, 'Bobby');
    await alice.client.removeContact(bob.identity.deviceId);

    const added = new Promise<Contact>((resolve) => alice.client.onInvitee(resolve));
    const { invitation } = await alice.client.invite('AZ', together);
    await bob.client.accept(invitation, 'BB', together);
    expect(await added).toEqual({ deviceId: bob.identity.deviceId, initials: 'BB', label: 'BB' });
    const received = nextMessage(alice.client);
    await bob.client.send(alice.identity.deviceId, 'back');
    expect(await received).toMatchObject({ name: 'BB', text: 'back' });
  });

  it('leaves every other contact as it was', async () => {
    const { alice, bob } = await aliceAndBob();
    const carol = await connect();
    const { invitation } = await alice.client.invite('AZ', together);
    await carol.client.accept(invitation, 'CC', together);
    await expect.poll(() => bookOf(alice.identity).contacts.size).toBe(2);

    await alice.client.removeContact(bob.identity.deviceId);
    await alice.client.syncContacts();
    expect([...bookOf(alice.identity).contacts.keys()]).toEqual([carol.identity.deviceId]);
    expect([...bookOf(carol.identity).contacts.keys()]).toEqual([alice.identity.deviceId]);
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
      close: () => {
        // Drop clients a failed test left open; otherwise closing waits for them and the
        // failure shows up only as a timeout.
        for (const client of fake.clients) client.terminate();
        return new Promise((resolve) => fake.close(resolve));
      },
    };
  }

  const alice = generateIdentity();
  const bob = generateIdentity();
  const carol = generateIdentity();
  // The fake server writes to bob as alice: bob met her, and she met him.
  beforeEach(() => befriendLocally(alice, bob));
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
      const client = clientFor(bob, fake.url);
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
      const client = clientFor(bob, fake.url);
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
      const client = clientFor(bob, fake.url);
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
      const client = clientFor(alice, fake.url);
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

  it('shows nothing from a key it never met, and does not acknowledge it', async () => {
    // Properly encrypted and signed — by carol, whom bob never met.
    const fake = await fakeServer((frame, socket) => {
      if (frame !== JSON.stringify({ action: 'fetch' })) return;
      const fromCarol = envelope('c1', encryptFor(carol, bob.deviceId, { v: 1, text: 'hello' }));
      socket.send(JSON.stringify({ ...fromCarol, envelope: { ...fromCarol.envelope, from: carol.deviceId } }));
      socket.send(JSON.stringify(envelope('m1'))); // from alice, whom he met
    });
    try {
      const client = clientFor(bob, fake.url);
      const received: string[] = [];
      client.onMessage((m) => received.push(`${m.name}: ${m.id}`));
      await client.connect();
      await expect.poll(() => received).toEqual(['XX: m1']);
      // The acknowledgement travels after the message is shown: wait for it to land.
      await expect.poll(() => fake.frames.filter((f) => f.includes('"ack"'))).toEqual([
        JSON.stringify({ action: 'ack', messageId: 'm1' }),
      ]);
      expect(received).toEqual(['XX: m1']); // and carol's never was
      await client.close();
    } finally {
      await fake.close();
    }
  });

  it('does not acknowledge a message nobody was listening for', async () => {
    const fake = await fakeServer((frame, socket) => {
      if (frame === JSON.stringify({ action: 'fetch' })) {
        socket.send(JSON.stringify(envelope('m1')));
        socket.send(JSON.stringify({ type: 'sent', messageId: 'done' })); // marks the end
      }
    });
    try {
      const client = clientFor(bob, fake.url);
      await client.connect();
      await client.send(alice.deviceId, 'x'); // resolves on the marker, after m1 was handled
      expect(fake.frames.filter((f) => f.includes('"ack"'))).toEqual([]);
      await client.close();
    } finally {
      await fake.close();
    }
  });

  describe('when the backend lies about an invitation', () => {
    it('believes only an invitee whose MAC was made with the secret, and only once', async () => {
      // Plays a backend that answers `invite` honestly, then — when the test sends a
      // message, once it knows the secret — relays whatever `invitee` events a
      // dishonest or compromised backend could.
      let events: object[] = [];
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'invite') {
          socket.send(JSON.stringify({ type: 'invited', tokenId: action.tokenId, expiresIn: 20 }));
        }
        if (action.action === 'send') {
          for (const event of events) socket.send(JSON.stringify(event));
          socket.send(JSON.stringify({ type: 'sent', messageId: 'done' })); // marks the end
        }
      });
      try {
        const client = clientFor(alice, fake.url);
        const invitees: Contact[] = [];
        let forged = 0;
        client.onInvitee((invitee) => invitees.push(invitee));
        client.onForgedInvitee(() => forged++);
        await client.connect();
        const { invitation } = await client.invite('AZ', together);
        const key = invitationKey(invitation.secret, 'room 1');
        const tokenId = invitationTokenId(key);
        const real = invitationMac(key, alice.deviceId, bob.deviceId, 'BB');
        const invitee = (over: object) => ({
          type: 'invitee', tokenId, invitee: bob.deviceId, initials: 'BB', mac: real, ...over,
        });
        events = [
          invitee({ invitee: carol.deviceId }), // bob's MAC, carol's key: swapped
          invitee({ initials: 'XX' }), // initials changed
          invitee({ mac: 'A'.repeat(43) }), // made up
          // made with the code alone, from another room
          invitee({ mac: invitationMac(invitationKey(invitation.secret, 'room 2'), alice.deviceId, bob.deviceId, 'BB') }),
          invitee({ tokenId: 'U'.repeat(43) }), // not an invitation of ours
          invitee({}), // the real one
          invitee({}), // and again
        ];
        await client.send(bob.deviceId, 'x'); // resolves on the marker, after all of them
        expect(invitees).toEqual([{ deviceId: bob.deviceId, initials: 'XX', label: 'XX' }]); // met before: unchanged
        // The four sealed with another key were reported; the stranger's token was not ours.
        expect(forged).toBe(4);
        expect(bookOf(alice).contacts.get(carol.deviceId)).toBeUndefined(); // the swapped-in key
        expect(bookOf(alice).contacts.get(bob.deviceId)?.label).toBe('XX'); // met before: left as it was
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('refuses an answer to accept that names another inviter', async () => {
      const fake = await fakeServer((frame, socket) => {
        if (JSON.parse(frame).action === 'accept') {
          socket.send(JSON.stringify({ type: 'accepted', inviter: carol.deviceId, initials: 'CC' }));
        }
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        await expect(
          client.accept({ inviter: alice.deviceId, secret: newInvitationSecret() }, 'BB', together),
        ).rejects.toThrow('someone else');
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('gives each answer to the request it is for, when two answers cross', async () => {
      // On AWS each frame is handled on its own: the second may be answered first.
      let held: (() => void) | undefined;
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'send') held = () => socket.send(JSON.stringify({ type: 'sent', messageId: 'm1' }));
        if (action.action === 'contacts') {
          socket.send(JSON.stringify({ type: 'contacts', contacts: [alice.deviceId] }));
          held?.();
        }
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        const sent = client.send(alice.deviceId, 'hi');
        await expect.poll(() => held).toBeDefined();
        const synced = client.syncContacts();
        expect(await synced).toBe('synced');
        expect(await sent).toEqual({ messageId: 'm1' });
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('gives a refusal to the request it is about, not to the one in front', async () => {
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'send') socket.send(JSON.stringify({ type: 'error', code: 'not_a_contact' }));
        if (action.action === 'contacts') {
          setTimeout(() => socket.send(JSON.stringify({ type: 'contacts', contacts: [alice.deviceId] })), 50);
        }
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        const synced = client.syncContacts(); // asked first, answered last
        const sent = client.send(alice.deviceId, 'hi');
        await expect(sent).rejects.toEqual(new ServerError('not_a_contact'));
        expect(await synced).toBe('synced');
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('gives up a request that is never answered, and ignores its answer if it comes late', async () => {
      let late: (() => void) | undefined;
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action !== 'remove') return;
        if (!late) late = () => socket.send(JSON.stringify({ type: 'removed', contact: action.contact }));
        else socket.send(JSON.stringify({ type: 'removed', contact: action.contact }));
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = client.removeContact(alice.deviceId);
        await expect.poll(() => late).toBeDefined();
        vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
        await expect(first).rejects.toThrow('no answer from the server');
        vi.useRealTimers();
        expect(bookOf(bob).contacts.size).toBe(1); // not answered, so not forgotten

        late!(); // the old answer arrives, then a new request is made and answered
        await new Promise((resolve) => setTimeout(resolve, 50));
        await client.removeContact(alice.deviceId);
        expect(bookOf(bob).contacts.size).toBe(0);
        await client.close();
      } finally {
        vi.useRealTimers();
        await fake.close();
      }
    });

    it('rejects a request answered with the wrong kind of reply', async () => {
      const fake = await fakeServer((frame, socket) => {
        if (JSON.parse(frame).action === 'invite') socket.send(JSON.stringify({ type: 'sent', messageId: 'm1' }));
      });
      try {
        const client = clientFor(alice, fake.url);
        await client.connect();
        await expect(client.invite('AZ', together)).rejects.toThrow('expected invited, got sent');
        await client.close();
      } finally {
        await fake.close();
      }
    });
  });

  it('never sends the room, or the secret, to the backend', async () => {
    const room = 'kitchen-7f3a';
    const fake = await fakeServer((frame, socket) => {
      const action = JSON.parse(frame);
      if (action.action === 'invite') {
        socket.send(JSON.stringify({ type: 'invited', tokenId: action.tokenId, expiresIn: 20 }));
      }
      if (action.action === 'accept') {
        socket.send(JSON.stringify({ type: 'accepted', inviter: alice.deviceId, initials: 'AZ' }));
      }
    });
    try {
      const inviter = clientFor(alice, fake.url);
      const invitee = clientFor(bob, fake.url);
      await inviter.connect();
      await invitee.connect();
      const { invitation } = await inviter.invite('AZ', sideBySide(room));
      await invitee.accept(invitation, 'BB', sideBySide(room));

      const sent = fake.frames.join('\n');
      expect(sent).toContain('"invite"');
      expect(sent).toContain('"accept"');
      expect(sent).not.toContain(room);
      expect(sent).not.toContain(invitation.secret);
      // …yet the room decides the token id: another room gives another one.
      const tokenIds = fake.frames.map((f) => JSON.parse(f).tokenId).filter(Boolean);
      expect(new Set(tokenIds).size).toBe(1);
      expect(tokenIds[0]).not.toBe(invitationTokenId(invitationKey(invitation.secret, 'elsewhere')));
      await inviter.close();
      await invitee.close();
    } finally {
      await fake.close();
    }
  });

  describe('following the backend on removals, and only on removals', () => {
    it('never adds a contact, whatever the backend lists or announces', async () => {
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'contacts') {
          socket.send(JSON.stringify({ type: 'contact_removed', contact: carol.deviceId })); // not ours
          socket.send(JSON.stringify({ type: 'contacts', contacts: [alice.deviceId, carol.deviceId] }));
        }
        if (action.action === 'remove') socket.send(JSON.stringify({ type: 'removed', contact: action.contact }));
      });
      try {
        const client = clientFor(bob, fake.url);
        const dropped: string[] = [];
        client.onContactRemoved((id) => dropped.push(id));
        await client.connect();
        await client.syncContacts();
        expect([...bookOf(bob).contacts.keys()]).toEqual([alice.deviceId]); // carol not added
        expect(dropped).toEqual([]);
        // …and the backend is asked to end the contact this device never made.
        expect(fake.frames.map((f) => JSON.parse(f))).toContainEqual({ action: 'remove', contact: carol.deviceId });
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('keeps a contact added while the answer to a sync was on its way', async () => {
      // The backend's list was read before bob accepted alice's invitation; it arrives after.
      let secret = '';
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'invite') {
          socket.send(JSON.stringify({ type: 'invited', tokenId: action.tokenId, expiresIn: 20 }));
        }
        if (action.action === 'contacts') {
          const key = invitationKey(secret, 'room 1');
          const mac = invitationMac(key, carol.deviceId, bob.deviceId, 'BB');
          socket.send(JSON.stringify({ type: 'invitee', tokenId: invitationTokenId(key), invitee: bob.deviceId, initials: 'BB', mac }));
          socket.send(JSON.stringify({ type: 'contacts', contacts: [] })); // from before
        }
      });
      try {
        const client = clientFor(carol, fake.url);
        await client.connect();
        secret = (await client.invite('CC', together)).invitation.secret;
        await client.syncContacts();
        expect([...bookOf(carol).contacts.keys()]).toEqual([bob.deviceId]);
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('does not end a contact the backend lists while an invitation of its own is open', async () => {
      // It may be the acceptance of that very invitation, known to the backend first.
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'invite') {
          socket.send(JSON.stringify({ type: 'invited', tokenId: action.tokenId, expiresIn: 20 }));
        }
        if (action.action === 'contacts') {
          socket.send(JSON.stringify({ type: 'contacts', contacts: [alice.deviceId, carol.deviceId] }));
        }
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        await client.invite('BB', together);
        await client.syncContacts();
        expect(fake.frames.map((f) => JSON.parse(f).action)).not.toContain('remove');
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('has forgotten the contact by the time removeContact returns, push or no push', async () => {
      const fake = await fakeServer((frame, socket) => {
        const action = JSON.parse(frame);
        if (action.action === 'remove') socket.send(JSON.stringify({ type: 'removed', contact: action.contact }));
      });
      try {
        const client = clientFor(bob, fake.url);
        await client.connect();
        await client.removeContact(alice.deviceId);
        expect(bookOf(bob).contacts.size).toBe(0);
        expect(fake.frames.map((f) => JSON.parse(f))).toContainEqual({ action: 'remove', contact: alice.deviceId });
        await client.close();
      } finally {
        await fake.close();
      }
    });

    it('drops a contact the backend says was removed, once, telling the listener once', async () => {
      const fake = await fakeServer((frame, socket) => {
        if (JSON.parse(frame).action === 'fetch') {
          socket.send(JSON.stringify({ type: 'contact_removed', contact: alice.deviceId }));
          socket.send(JSON.stringify({ type: 'contact_removed', contact: alice.deviceId }));
        }
      });
      try {
        const client = clientFor(bob, fake.url);
        const dropped: string[] = [];
        client.onContactRemoved((id) => dropped.push(id));
        await client.connect();
        await expect.poll(() => bookOf(bob).contacts.size).toBe(0);
        expect(dropped).toEqual([alice.deviceId]);
        await client.close();
      } finally {
        await fake.close();
      }
    });
  });
});
