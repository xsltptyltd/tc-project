import { describe, expect, it } from 'vitest';
import { MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { onConnect, onDisconnect } from '../src/core/connections';
import { onMessage } from '../src/core/router';
import { newDevice, testDeps } from './helpers';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const send = (to: string, ciphertext = 'c2VjcmV0') => JSON.stringify({ action: 'send', to, ciphertext });

describe('send', () => {
  it('stores the message and delivers it to a connected receiver', async () => {
    const t = testDeps();
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
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(t.store.messages.size).toBe(1);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('tells the sender the same thing whether or not the receiver is online', async () => {
    const online = testDeps();
    await onConnect(online.deps, 'conn-a', alice);
    await onConnect(online.deps, 'conn-b', bob);
    await onMessage(online.deps, 'conn-a', send(bob));

    const offline = testDeps();
    await onConnect(offline.deps, 'conn-a', alice);
    await onMessage(offline.deps, 'conn-a', send(bob));

    expect(online.eventsFor('conn-a')).toEqual(offline.eventsFor('conn-a'));
  });

  it('answers the sender before trying to deliver', async () => {
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.posted.map((p) => p.event.type)).toEqual(['sent', 'message']);
  });

  it('delivers to every connection of the receiver', async () => {
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b1', bob);
    await onConnect(t.deps, 'conn-b2', bob);

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(t.eventsFor('conn-b1')).toHaveLength(1);
    expect(t.eventsFor('conn-b2')).toHaveLength(1);
  });

  it('forgets a connection that has gone away', async () => {
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onConnect(t.deps, 'conn-b', bob);
    t.gone.add('conn-b');

    await onMessage(t.deps, 'conn-a', send(bob));

    expect(await t.store.listConnections(bob)).toEqual([]);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('takes the sender from the connection, not from the frame', async () => {
    const t = testDeps();
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
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', body);
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'error', code: 'bad_request' }]);
    expect(t.store.messages.size).toBe(0);
  });

  it('refuses a connection it does not know', async () => {
    const t = testDeps();
    await onMessage(t.deps, 'stranger', send(bob));
    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
    expect(t.store.messages.size).toBe(0);
  });

  it('stops accepting frames after disconnect', async () => {
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onDisconnect(t.deps, 'conn-a');
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.store.messages.size).toBe(0);
  });
});

describe('ack', () => {
  it('is not implemented yet', async () => {
    const t = testDeps();
    await onConnect(t.deps, 'conn-a', alice);
    await onMessage(t.deps, 'conn-a', JSON.stringify({ action: 'ack', messageId: 'm1' }));
    expect(t.eventsFor('conn-a')).toEqual([{ type: 'error', code: 'not_implemented' }]);
  });
});
