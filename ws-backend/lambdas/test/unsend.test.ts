// A sender taking back messages that have not been delivered yet (D17).
import { describe, expect, it } from 'vitest';
import { onConnect, onDisconnect } from '../src/core/connections';
import { onMessage } from '../src/core/router';
import { newDevice, testDeps } from './helpers';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;
const send = (to: string) => JSON.stringify({ action: 'send', to, ciphertext: 'c2VjcmV0' });
const unsend = (to: string, messageId?: string) => JSON.stringify({ action: 'unsend', to, messageId });
const fetchFrame = JSON.stringify({ action: 'fetch' });
const ack = (messageId: string) => JSON.stringify({ action: 'ack', messageId });

/** Alice online; Bob and Carol offline. */
async function aliceOnline() {
  const t = testDeps({ contacts: [alice, bob, carol] });
  await onConnect(t.deps, 'conn-a', alice);
  return t;
}

const deliveredTo = (t: ReturnType<typeof testDeps>, connectionId: string) =>
  t.eventsFor(connectionId).flatMap((e) => (e.type === 'message' ? [e.envelope.id] : []));

describe('taking back an undelivered message', () => {
  it('deletes it, so the receiver never gets it', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame);

    expect(t.store.messages.size).toBe(0);
    expect(deliveredTo(t, 'conn-b')).toEqual([]);
  });

  it('with a message id, deletes only that message', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));

    expect([...t.store.messages.keys()]).toEqual(['m2']);
  });

  it('without a message id, deletes all of them to that receiver — and only to that receiver', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(carol));

    await onMessage(t.deps, 'conn-a', unsend(bob));

    expect([...t.store.messages.keys()]).toEqual(['m3']);
  });

  it('answers nothing, to anyone', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    const before = t.posted.length;

    await onMessage(t.deps, 'conn-a', unsend(bob));

    expect(t.posted.length).toBe(before);
  });

  it('is harmless when repeated, or when there is nothing to take back', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));
    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));
    await onMessage(t.deps, 'conn-a', unsend(bob, 'no-such-message'));
    await onMessage(t.deps, 'conn-a', unsend(carol));

    expect(t.eventsFor('conn-a')).toEqual([{ type: 'sent', messageId: 'm1' }]);
  });

  it('keeps nothing about the deleted message', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', unsend(bob));
    expect(t.store.messages.size).toBe(0);
    expect(t.store.delivered.size).toBe(0);
  });
});

describe('only one’s own messages', () => {
  it('cannot take back someone else’s message to the same receiver', async () => {
    const t = await aliceOnline();
    await onConnect(t.deps, 'conn-c', carol);
    await onMessage(t.deps, 'conn-a', send(bob)); // m1, alice → bob
    await onMessage(t.deps, 'conn-c', send(bob)); // m2, carol → bob

    await onMessage(t.deps, 'conn-c', unsend(bob, 'm1'));
    await onMessage(t.deps, 'conn-c', unsend(bob));

    expect([...t.store.messages.keys()]).toEqual(['m1']);
  });

  it('cannot be used by the receiver to delete what was sent to them', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);

    await onMessage(t.deps, 'conn-b', unsend(bob, 'm1'));
    await onMessage(t.deps, 'conn-b', unsend(alice, 'm1'));

    expect(t.store.messages.has('m1')).toBe(true);
  });

  it('does not reach a message by naming the wrong receiver', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(carol, 'm1'));

    expect(t.store.messages.has('m1')).toBe(true);
  });

  it('refuses a connection it does not know', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'stranger', unsend(bob, 'm1'));

    expect(t.eventsFor('stranger')).toEqual([{ type: 'error', code: 'unknown_connection' }]);
    expect(t.store.messages.has('m1')).toBe(true);
  });
});

describe('delivered messages cannot be taken back', () => {
  it('not one delivered live, while the receiver was online', async () => {
    const t = await aliceOnline();
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));

    expect(deliveredTo(t, 'conn-b')).toEqual(['m1']);
    expect(t.store.messages.has('m1')).toBe(true); // until bob acknowledges it
  });

  it('not one delivered by a fetch and not acknowledged: it comes again', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b1', bob);
    await onMessage(t.deps, 'conn-b1', fetchFrame);
    await onDisconnect(t.deps, 'conn-b1');

    await onMessage(t.deps, 'conn-a', unsend(bob));
    await onConnect(t.deps, 'conn-b2', bob);
    await onMessage(t.deps, 'conn-b2', fetchFrame);

    expect(deliveredTo(t, 'conn-b2')).toEqual(['m1']);
  });

  it('takes back the undelivered ones and leaves the delivered ones', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob)); // m1
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-b', fetchFrame); // m1 delivered
    await onDisconnect(t.deps, 'conn-b');
    await onMessage(t.deps, 'conn-a', send(bob)); // m2, bob offline again

    await onMessage(t.deps, 'conn-a', unsend(bob));

    expect([...t.store.messages.keys()]).toEqual(['m1']);
  });

  it('not one whose delivery was attempted to a connection that had gone', async () => {
    // Marking comes before posting, so nothing the receiver may have can be taken back;
    // the price is that this one, which did not arrive, cannot be either.
    const t = await aliceOnline();
    await onConnect(t.deps, 'conn-b', bob);
    t.gone.add('conn-b');
    await onMessage(t.deps, 'conn-a', send(bob));

    await onMessage(t.deps, 'conn-a', unsend(bob));

    expect(t.store.messages.has('m1')).toBe(true);
  });

  it('a message taken back while a fetch was under way is not delivered by it', async () => {
    const t = await aliceOnline();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);
    // Alice's unsend lands between the fetch listing the message and delivering it.
    const list = t.store.listMessages.bind(t.store);
    t.store.listMessages = async (...args) => {
      const listed = await list(...args);
      await onMessage(t.deps, 'conn-a', unsend(bob));
      return listed;
    };

    await onMessage(t.deps, 'conn-b', fetchFrame);

    expect(deliveredTo(t, 'conn-b')).toEqual([]);
    expect(t.store.messages.size).toBe(0);
  });

  it('the sender sees exactly the same whether or not the message had been delivered', async () => {
    const delivered = await aliceOnline();
    await onConnect(delivered.deps, 'conn-b', bob);
    await onMessage(delivered.deps, 'conn-a', send(bob));
    await onMessage(delivered.deps, 'conn-a', unsend(bob, 'm1'));

    const undelivered = await aliceOnline();
    await onMessage(undelivered.deps, 'conn-a', send(bob));
    await onMessage(undelivered.deps, 'conn-a', unsend(bob, 'm1'));

    expect(delivered.eventsFor('conn-a')).toEqual(undelivered.eventsFor('conn-a'));
  });

  it('and once acknowledged there is nothing left to take back', async () => {
    const t = await aliceOnline();
    await onConnect(t.deps, 'conn-b', bob);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-b', ack('m1'));

    await onMessage(t.deps, 'conn-a', unsend(bob, 'm1'));

    expect(t.store.messages.size).toBe(0);
    expect(t.store.delivered.size).toBe(0);
  });
});
