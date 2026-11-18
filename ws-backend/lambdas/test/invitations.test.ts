// Invitations through the router (D1, D18), and what every ContactStore must do.
import { describe, expect, it } from 'vitest';
import { INVITATION_TTL_SECONDS } from 'tc-protocol';
import { DynamoStore } from '../src/adapters/dynamodb-store';
import { MemoryStore } from '../src/adapters/memory-store';
import { onConnect } from '../src/core/connections';
import type { ContactStore, InvitationRecord } from '../src/core/ports';
import { onMessage } from '../src/core/router';
import { FakeDynamoDB } from './fake-dynamodb';
import { newDevice, testDeps } from './helpers';

const NOW = 1_800_000_000;
const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;
const TOKEN = 'T'.repeat(43);
const MAC = 'M'.repeat(43);

const inviteFrame = (initials = 'AZ', tokenId = TOKEN) => JSON.stringify({ action: 'invite', tokenId, initials });
const acceptFrame = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'accept', tokenId: TOKEN, inviter: alice, initials: 'BB', mac: MAC, ...over });
const invalid = { type: 'error', code: 'invitation_invalid' };

/** alice on conn-a with an open invitation; bob on conn-b and carol on conn-c, connected. */
async function aliceInvites(options: Parameters<typeof testDeps>[0] = {}) {
  const t = testDeps({ now: NOW, ...options });
  await onConnect(t.deps, 'conn-a', alice);
  await onConnect(t.deps, 'conn-b', bob);
  await onConnect(t.deps, 'conn-c', carol);
  await onMessage(t.deps, 'conn-a', inviteFrame());
  return t;
}

describe('invite', () => {
  it('holds the invitation under its token id, for the inviter on this connection', async () => {
    const t = await aliceInvites();
    expect(t.store.invitations.get(TOKEN)).toEqual({
      tokenId: TOKEN,
      inviter: alice,
      initials: 'AZ',
      expiresAt: NOW + INVITATION_TTL_SECONDS,
    });
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'invited', tokenId: TOKEN, expiresIn: INVITATION_TTL_SECONDS }]);
  });

  it('lasts 20 seconds by default, or what the backend is set to', async () => {
    expect(INVITATION_TTL_SECONDS).toBe(20);
    const t = await aliceInvites({ invitationTtlSeconds: 5 });
    expect(t.store.invitations.get(TOKEN)?.expiresAt).toBe(NOW + 5);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'invited', tokenId: TOKEN, expiresIn: 5 }]);
  });

  it('takes the inviter from the connection, not from the frame', async () => {
    const t = testDeps({ now: NOW });
    await onConnect(t.deps, 'conn-c', carol);
    await onMessage(t.deps, 'conn-c', JSON.stringify({ action: 'invite', tokenId: TOKEN, initials: 'AZ', inviter: alice }));
    expect(t.store.invitations.get(TOKEN)?.inviter).toBe(carol);
  });

  it('does not let a second invitation replace one with the same token id', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-c', inviteFrame('CC'));
    expect(t.eventsFor('conn-c')).toEqual([invalid]);
    expect(t.store.invitations.get(TOKEN)).toMatchObject({ inviter: alice, initials: 'AZ' });
  });

  it.each([
    ['no initials', JSON.stringify({ action: 'invite', tokenId: TOKEN })],
    ['initials that are not A–Z', inviteFrame('a1')],
    ['five letters', inviteFrame('ABCDE')],
    ['a bad token id', inviteFrame('AZ', 'short')],
  ])('is refused as a bad request with %s', async (_label, frame) => {
    const t = testDeps({ now: NOW });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', frame);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'error', code: 'bad_request' }]);
    expect(t.store.invitations.size).toBe(0);
  });

  it('is refused on a connection it does not know', async () => {
    const t = testDeps({ now: NOW });
    await onMessage(t.deps, 'stranger', inviteFrame());
    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
    expect(t.store.invitations.size).toBe(0);
  });
});

describe('accept', () => {
  it("gives the invitee the inviter's initials, and the inviter the invitee, MAC untouched", async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.eventsFor('conn-b')).toEqual([{ type: 'accepted', inviter: alice, initials: 'AZ' }]);
    expect(t.eventsFor('conn-a').slice(1)).toEqual([
      { type: 'invitee', tokenId: TOKEN, invitee: bob, initials: 'BB', mac: MAC },
    ]);
    expect(t.eventsFor('conn-c')).toEqual([]);
  });

  it('answers the invitee before telling the inviter', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.posted.slice(1).map((p) => p.event.type)).toEqual(['accepted', 'invitee']);
  });

  it('takes the invitee from the connection, not from the frame', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame({ invitee: carol }));
    expect(t.eventsFor('conn-a').at(-1)).toMatchObject({ type: 'invitee', invitee: bob });
  });

  it('tells every connection of the inviter', async () => {
    const t = await aliceInvites();
    await onConnect(t.deps, 'conn-a2', alice);
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.eventsFor('conn-a2')).toEqual([t.eventsFor('conn-a').at(-1)]);
  });

  it('can be used once: nobody accepts it after that, not even the same device', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame());
    await onMessage(t.deps, 'conn-c', acceptFrame({ initials: 'CC' }));
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.eventsFor('conn-c')).toEqual([invalid]);
    expect(t.eventsFor('conn-b').at(-1)).toEqual(invalid);
    expect(t.eventsFor('conn-a').filter((e) => e.type === 'invitee')).toHaveLength(1);
    expect(t.store.invitations.get(TOKEN)?.acceptedBy).toBe(bob);
  });

  it('works until the last second of its lifetime, and not at the end of it', async () => {
    const late = await aliceInvites();
    late.clock.now = NOW + INVITATION_TTL_SECONDS - 1;
    await onMessage(late.deps, 'conn-b', acceptFrame());
    expect(late.eventsFor('conn-b')).toEqual([{ type: 'accepted', inviter: alice, initials: 'AZ' }]);

    const tooLate = await aliceInvites();
    tooLate.clock.now = NOW + INVITATION_TTL_SECONDS;
    await onMessage(tooLate.deps, 'conn-b', acceptFrame());
    expect(tooLate.eventsFor('conn-b')).toEqual([invalid]);
    expect(tooLate.eventsFor('conn-a')).toHaveLength(1); // only `invited`
  });

  it('is refused when it names another inviter, without using the invitation up', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame({ inviter: carol }));
    expect(t.eventsFor('conn-b')).toEqual([invalid]);
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.eventsFor('conn-b').at(-1)).toMatchObject({ type: 'accepted' });
  });

  it('is refused to the inviter itself, without using the invitation up', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-a', acceptFrame({ initials: 'AZ' }));
    expect(t.eventsFor('conn-a').at(-1)).toEqual(invalid);
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(t.eventsFor('conn-b')).toEqual([{ type: 'accepted', inviter: alice, initials: 'AZ' }]);
  });

  it('gives the same answer for every reason it is refused', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame({ tokenId: 'U'.repeat(43) })); // unknown
    await onMessage(t.deps, 'conn-b', acceptFrame({ inviter: carol })); // not hers
    await onMessage(t.deps, 'conn-c', acceptFrame()); // fine: uses it
    await onMessage(t.deps, 'conn-b', acceptFrame()); // used
    t.clock.now += 3600;
    await onMessage(t.deps, 'conn-b', acceptFrame()); // used and expired
    expect(t.eventsFor('conn-b')).toEqual([invalid, invalid, invalid, invalid]);
  });

  it('answers the invitee the same whether or not the inviter is connected (D14)', async () => {
    const online = await aliceInvites();
    await onMessage(online.deps, 'conn-b', acceptFrame());

    const offline = testDeps({ now: NOW });
    await onConnect(offline.deps, 'conn-a', alice);
    await onMessage(offline.deps, 'conn-a', inviteFrame());
    await offline.store.deleteConnection('conn-a');
    await onConnect(offline.deps, 'conn-b', bob);
    await onMessage(offline.deps, 'conn-b', acceptFrame());

    expect(offline.eventsFor('conn-b')).toEqual(online.eventsFor('conn-b'));
  });

  it("forgets an inviter's connection that has gone away", async () => {
    const t = await aliceInvites();
    t.gone.add('conn-a');
    await onMessage(t.deps, 'conn-b', acceptFrame());
    expect(await t.store.listConnections(alice)).toEqual([]);
    expect(t.eventsFor('conn-b')).toEqual([{ type: 'accepted', inviter: alice, initials: 'AZ' }]);
  });

  it.each([
    ['no MAC', { mac: undefined }],
    ['a bad MAC', { mac: 'short' }],
    ['initials that are not A–Z', { initials: 'bb' }],
    ['a bad inviter', { inviter: 'nobody' }],
  ])('is refused as a bad request with %s, without using the invitation up', async (_label, over) => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-b', acceptFrame(over));
    expect(t.eventsFor('conn-b')).toEqual([{ type: 'error', code: 'bad_request' }]);
    expect(t.store.invitations.get(TOKEN)?.acceptedBy).toBeUndefined();
  });
});

describe('expired invitations in memory', () => {
  it('are deleted by the sweeper, accepted or not, initials and all', async () => {
    const t = await aliceInvites();
    await onMessage(t.deps, 'conn-c', inviteFrame('CC', 'U'.repeat(43)));
    await onMessage(t.deps, 'conn-b', acceptFrame());
    t.store.sweep(NOW + INVITATION_TTL_SECONDS - 1);
    expect(t.store.invitations.size).toBe(2);
    t.store.sweep(NOW + INVITATION_TTL_SECONDS);
    expect(t.store.invitations.size).toBe(0);
  });

  it('go on the same timed sweep as messages', async () => {
    const store = new MemoryStore();
    const now = Math.floor(Date.now() / 1000);
    await store.putInvitation({ tokenId: TOKEN, inviter: alice, initials: 'AZ', expiresAt: now });
    const stop = store.startSweeping(10);
    try {
      await expect.poll(() => store.invitations.size).toBe(0);
    } finally {
      stop();
    }
  });
});

// The same behaviour from both stores (D16, D18, D19): the DynamoDB one through the
// stand-in client, two items per query page so that paging is exercised.
const contactStores: Array<[string, () => ContactStore]> = [
  ['in memory', () => new MemoryStore(() => NOW)],
  ['on DynamoDB (stand-in client)', () => new DynamoStore('table', new FakeDynamoDB(2))],
];

describe.each(contactStores)('a contact store %s', (_name, newStore) => {
  const record = (over: Partial<InvitationRecord> = {}): InvitationRecord => ({
    tokenId: TOKEN,
    inviter: alice,
    initials: 'AZ',
    expiresAt: NOW + 20,
    ...over,
  });
  const parties = { inviter: alice, invitee: bob };

  it('hands back the invitation it was given, accepted by the invitee', async () => {
    const store = newStore();
    expect(await store.putInvitation(record())).toBe(true);
    expect(await store.acceptInvitation(TOKEN, parties, NOW)).toEqual({ ...record(), acceptedBy: bob });
  });

  it('refuses a second invitation under the same token id, and keeps the first', async () => {
    const store = newStore();
    await store.putInvitation(record());
    expect(await store.putInvitation(record({ inviter: carol, initials: 'CC' }))).toBe(false);
    expect(await store.acceptInvitation(TOKEN, parties, NOW)).toMatchObject({ inviter: alice, initials: 'AZ' });
  });

  it('lets it be accepted once', async () => {
    const store = newStore();
    await store.putInvitation(record());
    expect(await store.acceptInvitation(TOKEN, parties, NOW)).toBeDefined();
    expect(await store.acceptInvitation(TOKEN, { inviter: alice, invitee: carol }, NOW)).toBeUndefined();
    expect(await store.acceptInvitation(TOKEN, parties, NOW)).toBeUndefined();
  });

  it('lets only one of two simultaneous acceptances through', async () => {
    const store = newStore();
    await store.putInvitation(record());
    const results = await Promise.all([
      store.acceptInvitation(TOKEN, parties, NOW),
      store.acceptInvitation(TOKEN, { inviter: alice, invitee: carol }, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses one that is unknown, expired, or not that inviter’s', async () => {
    const store = newStore();
    await store.putInvitation(record());
    expect(await store.acceptInvitation('U'.repeat(43), parties, NOW)).toBeUndefined();
    expect(await store.acceptInvitation(TOKEN, { inviter: carol, invitee: bob }, NOW)).toBeUndefined();
    expect(await store.acceptInvitation(TOKEN, parties, NOW + 20)).toBeUndefined();
    expect(await store.acceptInvitation(TOKEN, parties, NOW + 19)).toBeDefined(); // none of those used it
  });

  it('does not let a caller change what it stored', async () => {
    const store = newStore();
    const given = record();
    await store.putInvitation(given);
    given.inviter = carol;
    const accepted = await store.acceptInvitation(TOKEN, parties, NOW);
    accepted!.acceptedBy = carol;
    expect(await store.acceptInvitation(TOKEN, parties, NOW)).toBeUndefined();
  });

  it('makes the two contacts of each other when, and only when, it is accepted', async () => {
    const store = newStore();
    await store.putInvitation(record());
    expect(await store.isContact(alice, bob)).toBe(false);
    await store.acceptInvitation(TOKEN, { inviter: carol, invitee: bob }, NOW); // refused
    await store.acceptInvitation(TOKEN, parties, NOW + 20); // refused: expired
    expect(await store.isContact(alice, bob)).toBe(false);
    expect(await store.isContact(carol, bob)).toBe(false);

    await store.acceptInvitation(TOKEN, parties, NOW);
    expect(await store.isContact(alice, bob)).toBe(true);
    expect(await store.isContact(bob, alice)).toBe(true);
    expect(await store.isContact(alice, carol)).toBe(false);
    expect(await store.isContact(bob, carol)).toBe(false);
  });

  it('changes nothing when two contacts accept another invitation between them', async () => {
    const store = newStore();
    await store.putInvitation(record());
    await store.acceptInvitation(TOKEN, parties, NOW);
    await store.putInvitation(record({ tokenId: 'U'.repeat(43), inviter: bob, initials: 'BB' }));
    expect(await store.acceptInvitation('U'.repeat(43), { inviter: bob, invitee: alice }, NOW)).toBeDefined();
    expect(await store.isContact(alice, bob)).toBe(true);
    expect(await store.isContact(bob, alice)).toBe(true);
  });

  it('knows nobody as a contact of themselves', async () => {
    const store = newStore();
    expect(await store.isContact(alice, alice)).toBe(false);
  });

  it('lists the contacts of a device, and ends one for both sides at once', async () => {
    const store = newStore();
    await store.putInvitation(record());
    await store.acceptInvitation(TOKEN, parties, NOW);
    await store.putInvitation(record({ tokenId: 'U'.repeat(43) }));
    await store.acceptInvitation('U'.repeat(43), { inviter: alice, invitee: carol }, NOW);
    expect((await store.listContacts(alice)).sort()).toEqual([bob, carol].sort());
    expect(await store.listContacts(bob)).toEqual([alice]);

    await store.removeContact(bob, alice);
    expect(await store.listContacts(alice)).toEqual([carol]);
    expect(await store.listContacts(bob)).toEqual([]);
    expect(await store.isContact(alice, bob)).toBe(false);
    await expect(store.removeContact(bob, alice)).resolves.toBeUndefined(); // again: harmless
  });
});
