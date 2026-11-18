import { describe, expect, it } from 'vitest';
import { MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { onConnect, onDisconnect } from '../src/core/connections';
import { onMessage } from '../src/core/router';
import { newDevice, testDeps } from './helpers';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;
const send = (to: string, ciphertext = 'c2VjcmV0') => JSON.stringify({ action: 'send', to, ciphertext });
const fetchFrame = JSON.stringify({ action: 'fetch' });
const ack = (messageId: string) => JSON.stringify({ action: 'ack', messageId });
const SENT_AT = 1_800_000_000;

describe('send', () => {
  it('stores the message and delivers it to a connected receiver', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);

    await onMessage(t.deps, 'conn-a', send(bob));

    const envelope = {
      id: 'm1',
      from: alice,
      to: bob,
      ciphertext: 'c2VjcmV0',
      sentAt: 1_800_000_000,
      expiresAt: 1_800_000_000 + MESSAGE_TTL_SECONDS,
    };
    expect(t.store.messages.get('m1')).toEqual(envelope);
    expect(t.eventsFor('conn-b')).toEqual([{ type: 'message', envelope }]);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('stores the message when the receiver is offline', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(t.store.messages.size).toBe(1);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('tells the sender the same thing whether or not the receiver is online', async () => {
    const online = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(online.deps, 'conn-a', alice);
    await onConnect(online.deps, 'conn-b', bob);
    await onMessage(online.deps, 'conn-a', send(bob));

    const offline = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(offline.deps, 'conn-a', alice);
    await onMessage(offline.deps, 'conn-a', send(bob));

    expect(online.eventsFor('conn-a')).toEqual(offline.eventsFor('conn-a'));
  });

  it('answers the sender before trying to deliver', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.posted.map((p) => p.event.type)).toEqual(['sent', 'message']);
  });

  it('delivers to every connection of the receiver', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b1', bob);
    await onConnect(t.deps, 'conn-b2', bob);

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(t.eventsFor('conn-b1')).toHaveLength(1);
    expect(t.eventsFor('conn-b2')).toHaveLength(1);
  });

  it('forgets a connection that has gone away', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    t.gone.add('conn-b');

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(await t.store.listConnections(bob)).toEqual([]);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('takes the sender from the connection, not from the frame', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'send', to: bob, ciphertext: 'abc', from: bob }));
    expect(t.store.messages.get('m1')?.from).toBe(alice);
  });
});

describe('bad input', () => {
  it.each([
    ['not json', '{'],
    ['unknown action', JSON.stringify({ action: 'shout' })],
    ['bad receiver', send('nobody')],
  ])('answers bad_request for %s', async (_label, body) => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', body);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'error', code: 'bad_request' }]);
    expect(t.store.messages.size).toBe(0);
  });

  it('refuses a connection it does not know', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onMessage(t.deps, 'stranger', send(bob));
    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
    expect(t.store.messages.size).toBe(0);
  });

  it('stops accepting frames after disconnect', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onDisconnect(t.deps, 'conn-a');
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.store.messages.size).toBe(0);
  });
});


describe('fetch', () => {
  it('delivers messages sent while the receiver was offline, oldest first', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob, 'b25l'));
    await onMessage(t.deps, 'conn-a', send(bob, 'dHdv'));

    t.clock.now += 3600;
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame);

    expect(t.eventsFor('conn-b')).toEqual([
      { type: 'message', envelope: t.store.messages.get('m1') },
      { type: 'message', envelope: t.store.messages.get('m2') },
    ]);
    expect(t.eventsFor('conn-b').map((e) => e.type === 'message' && e.envelope.ciphertext)).toEqual([
      'b25l',
      'dHdv',
    ]);
  });

  it('delivers only messages addressed to the device that asks', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(carol));
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', send(alice));

    await onMessage(t.deps, 'conn-b', fetchFrame);

    const delivered = t.eventsFor('conn-b').filter((e) => e.type === 'message');
    expect(delivered).toEqual([{ type: 'message', envelope: t.store.messages.get('m2') }]);
  });

  it('answers only the connection that asks', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b1', bob);
    await onConnect(t.deps, 'conn-b2', bob);

    await onMessage(t.deps, 'conn-b1', fetchFrame);

    expect(t.eventsFor('conn-b1')).toHaveLength(1);
    expect(t.eventsFor('conn-b2')).toEqual([]);
  });

  it('sends nothing when nothing is waiting', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame);
    expect(t.posted).toEqual([]);
  });

  it('keeps a delivered message that was not acknowledged, so a reconnecting device gets it again', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));

    await onConnect(t.deps, 'conn-b1', bob);
    await onMessage(t.deps, 'conn-b1', fetchFrame);
    await onDisconnect(t.deps, 'conn-b1');
    await onConnect(t.deps, 'conn-b2', bob);
    await onMessage(t.deps, 'conn-b2', fetchFrame);

    expect(t.eventsFor('conn-b1')).toHaveLength(1);
    expect(t.eventsFor('conn-b2')).toEqual(t.eventsFor('conn-b1'));
  });

  it('delivers a message until its last second, never after 24 hours', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);

    t.clock.now = SENT_AT + MESSAGE_TTL_SECONDS - 1;
    await onMessage(t.deps, 'conn-b', fetchFrame);
    expect(t.eventsFor('conn-b')).toHaveLength(1);

    t.clock.now = SENT_AT + MESSAGE_TTL_SECONDS;
    await onMessage(t.deps, 'conn-b', fetchFrame);
    expect(t.eventsFor('conn-b')).toHaveLength(1);
  });

  it('delivers the unexpired messages and not the expired ones', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob)); // m1, expires first
    t.clock.now += 3600;
    await onMessage(t.deps, 'conn-a', send(bob)); // m2

    t.clock.now = SENT_AT + MESSAGE_TTL_SECONDS;
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame);

    expect(t.eventsFor('conn-b')).toEqual([{ type: 'message', envelope: t.store.messages.get('m2') }]);
  });

  it('removes expired messages from the in-memory store', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(carol));

    t.clock.now = SENT_AT + MESSAGE_TTL_SECONDS;
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame);

    // carol's message went too: she may never come back to ask for it
    expect(t.store.messages.size).toBe(0);
  });

  it('stops and forgets the connection if it has gone away', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);
    t.gone.add('conn-b');

    await onMessage(t.deps, 'conn-b', fetchFrame);

    expect(await t.store.listConnections(bob)).toEqual([]);
    expect(t.store.messages.size).toBe(2);
  });

  it('refuses a connection it does not know', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'stranger', fetchFrame);

    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
  });
});

describe('ack', () => {
  it('deletes the message, so it is not delivered again', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b1', bob);
    await onMessage(t.deps, 'conn-b1', fetchFrame);

    await onMessage(t.deps, 'conn-b1', ack('m1'));
    await onDisconnect(t.deps, 'conn-b1');
    await onConnect(t.deps, 'conn-b2', bob);
    await onMessage(t.deps, 'conn-b2', fetchFrame);

    expect(t.store.messages.has('m1')).toBe(false);
    expect(t.eventsFor('conn-b1')).toHaveLength(1);
    expect(t.eventsFor('conn-b2')).toEqual([]);
  });

  it('deletes only the message it names', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);

    await onMessage(t.deps, 'conn-b', ack('m1'));

    expect([...t.store.messages.keys()]).toEqual(['m2']);
  });

  it('deletes a message delivered live, too', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-b', ack('m1'));

    expect(t.store.messages.size).toBe(0);
  });

  it.each([
    ['the sender', () => alice],
    ['a third device', () => carol],
  ])('cannot be used by %s to delete someone else’s message', async (_label, who) => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-x', who());

    await onMessage(t.deps, 'conn-x', ack('m1'));

    expect(t.store.messages.has('m1')).toBe(true);
    expect(t.eventsFor('conn-x')).toEqual([]); // not even whether it exists
  });

  it('answers nothing, and tells the sender nothing', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);
    const before = t.posted.length;

    await onMessage(t.deps, 'conn-b', ack('m1'));

    expect(t.posted.length).toBe(before);
  });

  it('is harmless when repeated or when the message does not exist', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);

    await onMessage(t.deps, 'conn-b', ack('m1'));
    await onMessage(t.deps, 'conn-b', ack('m1'));
    await onMessage(t.deps, 'conn-b', ack('no-such-message'));

    expect(t.eventsFor('conn-b')).toEqual([]);
  });

  it('refuses a connection it does not know', async () => {
    const t = testDeps({ contacts: [alice, bob, carol] });
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'stranger', ack('m1'));

    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
    expect(t.store.messages.has('m1')).toBe(true);
  });
});
