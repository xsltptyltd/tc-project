// Messages live one second here instead of 24 hours, to watch them expire (D8). The
// clock and the sweeper's timer are both driven by the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onConnect } from '../src/core/connections';
import { onMessage } from '../src/core/router';
import { newDevice, testDeps } from './helpers';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
const carol = newDevice().deviceId;
const send = (to: string) => JSON.stringify({ action: 'send', to, ciphertext: 'c2VjcmV0' });
const fetchFrame = JSON.stringify({ action: 'fetch' });
const T = 1_800_000_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Alice, online, with a one-second message lifetime. */
async function oneSecondTtl() {
  const t = testDeps({ now: T, messageTtlSeconds: 1 });
  await onConnect(t.deps, 'conn-a', alice);
  return t;
}

describe('a one-second message lifetime', () => {
  it('is what a message is sent with', async () => {
    const t = await oneSecondTtl();
    await onMessage(t.deps, 'conn-a', send(bob));
    expect(t.store.messages.get('m1')).toMatchObject({ sentAt: T, expiresAt: T + 1 });
  });

  it('deletes undelivered messages once expired, even if nobody asks for them', async () => {
    const t = await oneSecondTtl();
    const stopSweeping = t.store.startSweeping(1000);
    await onMessage(t.deps, 'conn-a', send(bob));
    await onMessage(t.deps, 'conn-a', send(carol));

    vi.advanceTimersByTime(1000); // a sweep, still within the message's second
    expect(t.store.messages.size).toBe(2);

    t.clock.now = T + 1;
    vi.advanceTimersByTime(1000); // the next sweep, after expiry
    expect(t.store.messages.size).toBe(0);
    // Nobody fetched: the sweeper alone deleted them.
    expect(t.posted.filter((p) => p.event.type === 'message')).toEqual([]);
    stopSweeping();
  });

  it('delivers a message within its second and never after — without waiting for a sweep', async () => {
    const t = await oneSecondTtl();
    await onMessage(t.deps, 'conn-a', send(bob));
    await onConnect(t.deps, 'conn-b', bob);

    await onMessage(t.deps, 'conn-b', fetchFrame); // at T: in time, not acknowledged
    t.clock.now = T + 1;
    await onMessage(t.deps, 'conn-b', fetchFrame); // at T + 1: expired

    expect(t.eventsFor('conn-b').map((e) => e.type)).toEqual(['message']);
    expect(t.store.messages.size).toBe(0);
  });

  it('keeps a message that has not expired yet', async () => {
    const t = await oneSecondTtl();
    const stopSweeping = t.store.startSweeping(1000);
    await onMessage(t.deps, 'conn-a', send(bob));
    t.clock.now = T + 1;
    await onMessage(t.deps, 'conn-a', send(bob)); // m2 lives until T + 2

    vi.advanceTimersByTime(1000);

    expect([...t.store.messages.keys()]).toEqual(['m2']);
    stopSweeping();
  });

  it('stops sweeping when told to', async () => {
    const t = await oneSecondTtl();
    const stopSweeping = t.store.startSweeping(1000);
    await onMessage(t.deps, 'conn-a', send(bob));

    stopSweeping();
    t.clock.now = T + 5;
    vi.advanceTimersByTime(5000);

    expect(t.store.messages.size).toBe(1); // still expired, never delivered (see above)
    expect(vi.getTimerCount()).toBe(0);
  });
});
