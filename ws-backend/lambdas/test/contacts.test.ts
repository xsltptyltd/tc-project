// Only contacts can write to each other (D19), and accepting an invitation is what makes
// two devices contacts (D18).
import { describe, expect, it } from 'vitest';
import { onConnect, onDisconnect } from '../src/core/connections';
import { onMessage } from '../src/core/router';
import { newDevice, testDeps } from './helpers';

const NOW = 1_800_000_000;
const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;
const TOKEN = 'T'.repeat(43);
const send = (to: string) => JSON.stringify({ action: 'send', to, ciphertext: 'c2VjcmV0' });
const notAContact = { type: 'error', code: 'not_a_contact' };

async function strangers() {
  const t = testDeps({ now: NOW });
  await onConnect(t.deps, 'conn-a', alice);
  await onConnect(t.deps, 'conn-b', bob);
  await onConnect(t.deps, 'conn-c', carol);
  return t;
}

async function aliceAndBobMeet(t: Awaited<ReturnType<typeof strangers>>) {
  await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'invite', tokenId: TOKEN, initials: 'AZ' }));
  await onMessage(
    t.deps,
    'conn-b',
    JSON.stringify({ action: 'accept', tokenId: TOKEN, inviter: alice, initials: 'BB', mac: 'M'.repeat(43) }),
  );
}

const messagesTo = (t: Awaited<ReturnType<typeof strangers>>, connectionId: string) =>
  t.eventsFor(connectionId).filter((e) => e.type === 'message');

describe('between two devices that are not contacts', () => {
  it('a message is refused, nothing is stored and nothing is delivered', async () => {
    const t = await strangers();
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.eventsFor('conn-a')).toEqual([notAContact]);
    expect(t.store.messages.size).toBe(0);
    expect(t.eventsFor('conn-b')).toEqual([]);
  });

  it('a message is refused in either direction, whether the receiver is online or not', async () => {
    const t = await strangers();
    await onMessage(t.deps, 'conn-b', send(alice));
    await onMessage(t.deps, 'conn-b', send(newDevice().deviceId)); // never connected
    expect(t.eventsFor('conn-b')).toEqual([notAContact, notAContact]);
    expect(t.store.messages.size).toBe(0);
  });

  it('showing an invitation is not enough: it has to be accepted', async () => {
    const t = await strangers();
    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'invite', tokenId: TOKEN, initials: 'AZ' }));
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-b', send(alice));
    expect(t.eventsFor('conn-a').at(-1)).toEqual(notAContact);
    expect(t.eventsFor('conn-b')).toEqual([notAContact]);
  });
});

describe('once an invitation is accepted', () => {
  it('the two can write to each other, both ways', async () => {
    const t = await strangers();
    await aliceAndBobMeet(t);

    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-b', send(alice));
    expect(messagesTo(t, 'conn-b')).toHaveLength(1);
    expect(messagesTo(t, 'conn-a')).toHaveLength(1);
    expect(t.eventsFor('conn-a').filter((e) => e.type === 'error')).toEqual([]);
  });

  it('nobody else gains anything: a contact of a contact is still a stranger', async () => {
    const t = await strangers();
    await aliceAndBobMeet(t);

    await onMessage(t.deps, 'conn-c', send(alice));
    await onMessage(t.deps, 'conn-c', send(bob));
    await onMessage(t.deps, 'conn-a', send(carol));
    expect(t.eventsFor('conn-c')).toEqual([notAContact, notAContact]);
    expect(t.eventsFor('conn-a').at(-1)).toEqual(notAContact);
  });

  it('a refused acceptance makes nobody a contact', async () => {
    const t = await strangers();
    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'invite', tokenId: TOKEN, initials: 'AZ' }));
    const accept = (tokenId: string) =>
      JSON.stringify({ action: 'accept', tokenId, inviter: alice, initials: 'CC', mac: 'M'.repeat(43) });
    await onMessage(t.deps, 'conn-c', accept('U'.repeat(43))); // e.g. the code, from another room
    await onMessage(t.deps, 'conn-c', send(alice));
    expect(t.eventsFor('conn-c')).toEqual([{ type: 'error', code: 'invitation_invalid' }, notAContact]);
  });
});

describe('removing a contact', () => {
  const remove = (contact: string) => JSON.stringify({ action: 'remove', contact });
  const contactsFrame = JSON.stringify({ action: 'contacts' });

  async function aliceBobAndCarol() {
    const t = testDeps({ now: NOW, contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    await onConnect(t.deps, 'conn-c', carol);
    return t;
  }

  it('ends it for both: neither can write to the other any more', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-a', remove(bob));
    expect(t.eventsFor('conn-a')).toContainEqual({ type: 'removed', contact: bob });
    expect(await t.store.isContact(alice, bob)).toBe(false);
    expect(await t.store.isContact(bob, alice)).toBe(false);

    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-b', send(alice));
    expect(t.eventsFor('conn-a').at(-1)).toEqual(notAContact);
    expect(t.eventsFor('conn-b').at(-1)).toEqual(notAContact);
  });

  it('touches no other contact', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-a', remove(bob));
    expect(await t.store.listContacts(alice)).toEqual([carol]);
    expect((await t.store.listContacts(bob)).sort()).toEqual([carol]);
  });

  it('deletes every message still waiting between them, both ways, delivered or not — and no others', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-b', send(alice)); // m1: delivered live, not acknowledged
    await onDisconnect(t.deps, 'conn-b');
    await onMessage(t.deps, 'conn-a', send(bob)); // m2: waiting
    await onMessage(t.deps, 'conn-a', send(carol)); // m3: alice to carol
    await onMessage(t.deps, 'conn-c', send(bob)); // m4: carol to bob

    await onMessage(t.deps, 'conn-a', remove(bob));
    expect([...t.store.messages.keys()].sort()).toEqual(['m3', 'm4']);
  });

  it('tells every connection on both sides, so each device drops it — the one removed too', async () => {
    const t = await aliceBobAndCarol();
    await onConnect(t.deps, 'conn-a2', alice);
    await onConnect(t.deps, 'conn-b2', bob);
    await onMessage(t.deps, 'conn-a', remove(bob));

    const dropped = (connectionId: string) => t.eventsFor(connectionId).filter((e) => e.type === 'contact_removed');
    expect(dropped('conn-b')).toEqual([{ type: 'contact_removed', contact: alice }]);
    expect(dropped('conn-b2')).toEqual([{ type: 'contact_removed', contact: alice }]);
    expect(dropped('conn-a2')).toEqual([{ type: 'contact_removed', contact: bob }]);
    expect(dropped('conn-c')).toEqual([]);
  });

  it('answers the same whether or not they were contacts, and can be repeated', async () => {
    const t = await aliceBobAndCarol();
    const stranger = newDevice().deviceId;
    await onMessage(t.deps, 'conn-a', remove(stranger));
    await onMessage(t.deps, 'conn-a', remove(bob));
    await onMessage(t.deps, 'conn-a', remove(bob));
    const answers = t.eventsFor('conn-a').filter((e) => e.type === 'removed');
    expect(answers).toEqual([
      { type: 'removed', contact: stranger },
      { type: 'removed', contact: bob },
      { type: 'removed', contact: bob },
    ]);
  });

  it('does nothing, and tells nobody, when the two were never contacts', async () => {
    const t = await strangers();
    await onMessage(t.deps, 'conn-c', remove(alice));
    expect(t.eventsFor('conn-c')).toEqual([{ type: 'removed', contact: alice }]);
    // A stranger cannot make the backend write to a device it never met.
    expect(t.eventsFor('conn-a')).toEqual([]);
  });

  it("takes the one removing from the connection: nobody can end someone else's contact", async () => {
    const t = await aliceBobAndCarol();
    // carol names bob; the backend reads it as "carol removes bob" — alice and bob stay.
    await onMessage(t.deps, 'conn-c', JSON.stringify({ action: 'remove', contact: bob, owner: alice }));
    expect(await t.store.isContact(alice, bob)).toBe(true);
    expect(await t.store.isContact(carol, bob)).toBe(false);
  });

  it('keeps nothing: once removed, the two are strangers again, until they meet again', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-a', remove(bob));
    expect(t.store.contacts.get(alice)?.has(bob) ?? false).toBe(false);
    await onMessage(t.deps, 'conn-a', remove(carol));
    expect(t.store.contacts.has(alice)).toBe(false); // not even an empty list

    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'invite', tokenId: TOKEN, initials: 'AZ' }));
    await onMessage(
      t.deps,
      'conn-b',
      JSON.stringify({ action: 'accept', tokenId: TOKEN, inviter: alice, initials: 'BB', mac: 'M'.repeat(43) }),
    );
    await onMessage(t.deps, 'conn-b', send(alice));
    expect(t.eventsFor('conn-b').at(-1)).toEqual({ type: 'sent', messageId: expect.any(String) });
  });

  it('tells a device who its contacts are, and nothing about anyone else’s', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-a', remove(bob));
    await onMessage(t.deps, 'conn-b', contactsFrame);
    expect(t.eventsFor('conn-b').at(-1)).toEqual({ type: 'contacts', contacts: [carol] });
  });

  it('refuses a remove without a valid contact', async () => {
    const t = await aliceBobAndCarol();
    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'remove', contact: 'nobody' }));
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'error', code: 'bad_request' }]);
    expect(await t.store.isContact(alice, bob)).toBe(true);
  });
});
