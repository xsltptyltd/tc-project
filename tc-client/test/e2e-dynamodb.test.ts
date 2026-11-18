// Real clients and the local server, with the server on the DynamoDB store the Lambdas use
// — talking to the stand-in client instead of AWS. The contact features, end to end.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateIdentity, init, type Identity } from 'tc-crypto';
import { startLocalServer, type LocalServer } from '../../ws-backend/lambdas/local/server';
import { DynamoStore } from '../../ws-backend/lambdas/src/adapters/dynamodb-store';
import { FakeDynamoDB } from '../../ws-backend/lambdas/test/fake-dynamodb';
import { MemoryContactBook, NotAContact, ServerError, TcClient, type Contact, type Proximity } from '../src';

let server: LocalServer<DynamoStore>;
let table: FakeDynamoDB;
const clients: TcClient[] = [];
const books = new Map<string, MemoryContactBook>();
const bookOf = (id: Identity) => books.get(id.deviceId) ?? books.set(id.deviceId, new MemoryContactBook()).get(id.deviceId)!;
const room = (value: string): Proximity => ({ announce: async () => ({ value, stop() {} }), sense: async () => value });

async function connect(identity = generateIdentity()) {
  const client = new TcClient(identity, server.url, bookOf(identity));
  clients.push(client);
  await client.connect();
  return { client, identity };
}

async function meet(a: Awaited<ReturnType<typeof connect>>, b: Awaited<ReturnType<typeof connect>>) {
  const added = new Promise<Contact>((resolve) => a.client.onInvitee(resolve));
  const { invitation } = await a.client.invite('AZ', room('kitchen'));
  await b.client.accept(invitation, 'BB', room('kitchen'));
  await added;
}

beforeAll(() => init());
beforeEach(async () => {
  books.clear();
  table = new FakeDynamoDB(2);
  server = await startLocalServer(0, '127.0.0.1', { store: new DynamoStore('table', table) });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await server.close();
});

describe('contacts on DynamoDB, end to end', () => {
  it('refuses strangers, then lets two who met write both ways', async () => {
    const alice = await connect();
    const bob = await connect();
    books.get(alice.identity.deviceId)!.contacts.set(bob.identity.deviceId, { deviceId: bob.identity.deviceId, initials: 'BB', label: 'BB' });
    await expect(alice.client.send(bob.identity.deviceId, 'hi')).rejects.toEqual(new ServerError('not_a_contact'));

    await meet(alice, bob);
    const toBob = new Promise<string>((resolve) => bob.client.onMessage((m) => resolve(m.text)));
    await alice.client.send(bob.identity.deviceId, 'hello');
    expect(await toBob).toBe('hello');
  });

  it('refuses a code from another room without using it up', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    const { invitation } = await alice.client.invite('AZ', room('kitchen'));
    await expect(carol.client.accept(invitation, 'CC', room('garden'))).rejects.toEqual(new ServerError('invitation_invalid'));
    await expect(bob.client.accept(invitation, 'BB', room('kitchen'))).resolves.toMatchObject({ label: 'AZ' });
  });

  it('removes a contact from both lists at once, and from an offline list on its next sync', async () => {
    const alice = await connect();
    const bob = await connect();
    const carol = await connect();
    await meet(alice, bob);
    await meet(alice, carol);
    await carol.client.close();

    const bobDropped = new Promise<string>((resolve) => bob.client.onContactRemoved(resolve));
    await alice.client.removeContact(bob.identity.deviceId);
    await alice.client.removeContact(carol.identity.deviceId);
    expect(await bobDropped).toBe(alice.identity.deviceId);
    expect(bookOf(alice.identity).contacts.size).toBe(0);
    expect(bookOf(carol.identity).contacts.size).toBe(1); // offline: not yet

    const carolAgain = await connect(carol.identity);
    await carolAgain.client.syncContacts();
    expect(bookOf(carol.identity).contacts.size).toBe(0);
    await expect(bob.client.send(alice.identity.deviceId, 'hi')).rejects.toThrow(NotAContact);
    expect([...table.items.keys()].filter((k) => k.includes('|CONTACT#'))).toEqual([]);
  });

  it('deletes what was waiting between them when a contact ends', async () => {
    const alice = await connect();
    const bob = await connect();
    await meet(alice, bob);
    await bob.client.close();
    await alice.client.send(bob.identity.deviceId, 'one');
    await alice.client.send(bob.identity.deviceId, 'two');
    expect([...table.items.keys()].filter((k) => k.includes('|MSG#'))).toHaveLength(2);
    await alice.client.removeContact(bob.identity.deviceId);
    expect([...table.items.keys()].filter((k) => k.includes('|MSG#'))).toEqual([]);
  });
});
