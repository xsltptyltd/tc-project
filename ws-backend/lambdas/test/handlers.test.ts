// The Lambda entry points, driven with the events API Gateway sends. They are thin, but
// they are the only code that reads those events, so a wrong field would only show once
// deployed. AWS itself is replaced: the DynamoDB store talks to the in-memory stand-in,
// and the transport records what would have been posted and to which endpoint.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from 'tc-protocol';
import { INVITATION_TTL_SECONDS, MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { DynamoStore } from '../src/adapters/dynamodb-store';
import type { Deps } from '../src/core/ports';
import { FakeDynamoDB } from './fake-dynamodb';
import { newDevice } from './helpers';

const world = vi.hoisted(() => ({
  deps: undefined as unknown as Deps,
  contexts: [] as Array<{ domainName: string; stage: string }>,
}));
vi.mock('../src/adapters/aws', () => ({
  awsDeps(requestContext: { domainName: string; stage: string }) {
    world.contexts.push(requestContext);
    return world.deps;
  },
}));

import { handler as connect } from '../src/handlers/connect';
import { handler as disconnect } from '../src/handlers/disconnect';
import { handler as router } from '../src/handlers/router';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;
let db: FakeDynamoDB;

let posted: Array<{ connectionId: string; event: ServerEvent }>;

beforeEach(() => {
  db = new FakeDynamoDB();
  posted = [];
  world.contexts.length = 0;
  let nextId = 1;
  const store = new DynamoStore('table', db);
  world.deps = {
    store,
    now: () => 1_800_000_000,
    newId: () => `m${nextId++}`,
    messageTtlSeconds: MESSAGE_TTL_SECONDS,
    contacts: store, // one table for everything (D16)
    invitationTtlSeconds: INVITATION_TTL_SECONDS,
    transport: {
      async post(connectionId, event) {
        posted.push({ connectionId, event });
        return true;
      },
    },
  };
});

/** The parts of an API Gateway websocket event the handlers read. */
const event = (connectionId: string, extra: { principalId?: string; body?: string } = {}) =>
  ({
    requestContext: {
      connectionId,
      domainName: 'abc123.execute-api.us-west-2.amazonaws.com',
      stage: 'dev',
      ...(extra.principalId !== undefined && { authorizer: { principalId: extra.principalId } }),
    },
    body: extra.body,
  }) as never;

describe('lambda handlers', () => {
  it('connect records the device the authorizer named', async () => {
    expect(await connect(event('c-a', { principalId: alice }))).toEqual({ statusCode: 200, body: '' });
    expect(await world.deps.store.getConnection('c-a')).toMatchObject({ deviceId: alice });
  });

  it('connect refuses an event without a valid device from the authorizer', async () => {
    expect((await connect(event('c-a'))).statusCode).toBe(401);
    expect((await connect(event('c-a', { principalId: 'not-a-device-id' }))).statusCode).toBe(401);
    expect(db.items.size).toBe(0);
  });

  const frame = (connectionId: string, body: object) => router(event(connectionId, { body: JSON.stringify(body) }));
  const TOKEN = 'T'.repeat(43);
  const MAC = 'M'.repeat(43);

  /** alice and bob meet, through the handlers: an invitation, accepted. */
  async function meet() {
    await connect(event('c-a', { principalId: alice }));
    await connect(event('c-b', { principalId: bob }));
    await frame('c-a', { action: 'invite', tokenId: TOKEN, initials: 'AZ' });
    await frame('c-b', { action: 'accept', tokenId: TOKEN, inviter: alice, initials: 'BB', mac: MAC });
    posted.length = 0;
  }

  it('carries a message from one connection to another, then forgets it on acknowledgement', async () => {
    await meet();
    await disconnect(event('c-b'));
    await frame('c-a', { action: 'send', to: bob, ciphertext: 'c2VjcmV0' });

    await connect(event('c-b', { principalId: bob }));
    await frame('c-b', { action: 'fetch' });
    expect(posted.map((p) => [p.connectionId, p.event.type])).toEqual([
      ['c-a', 'sent'],
      ['c-b', 'message'],
    ]);

    await frame('c-b', { action: 'ack', messageId: 'm1' });
    await disconnect(event('c-a'));
    await disconnect(event('c-b'));
    // No message, no connection: only the contact (both sides) and the accepted
    // invitation, which the table's TTL deletes.
    expect([...db.items.keys()].sort()).toEqual(
      [`DEVICE#${alice}|CONTACT#${bob}`, `DEVICE#${bob}|CONTACT#${alice}`, `INVITATION#${TOKEN}|INVITATION`].sort(),
    );
  });

  it('takes two devices from strangers to contacts and back, all on the table', async () => {
    await connect(event('c-a', { principalId: alice }));
    await connect(event('c-b', { principalId: bob }));
    await frame('c-a', { action: 'send', to: bob, ciphertext: 'c2VjcmV0' });
    expect(posted.at(-1)?.event).toEqual({ type: 'error', code: 'not_a_contact' });

    await frame('c-a', { action: 'invite', tokenId: TOKEN, initials: 'AZ' });
    await frame('c-b', { action: 'accept', tokenId: TOKEN, inviter: alice, initials: 'BB', mac: MAC });
    expect(posted.map((p) => p.event.type).slice(-3)).toEqual(['invited', 'accepted', 'invitee']);

    await frame('c-b', { action: 'send', to: alice, ciphertext: 'c2VjcmV0' });
    expect(posted.filter((p) => p.connectionId === 'c-a').at(-1)?.event.type).toBe('message');

    await frame('c-a', { action: 'remove', contact: bob });
    await frame('c-b', { action: 'contacts' });
    expect(posted.filter((p) => p.connectionId === 'c-b').map((p) => p.event.type).slice(-2)).toEqual([
      'contact_removed',
      'contacts',
    ]);
    expect(posted.at(-1)?.event).toEqual({ type: 'contacts', contacts: [] });
    await frame('c-b', { action: 'send', to: alice, ciphertext: 'c2VjcmV0' });
    expect(posted.at(-1)?.event).toEqual({ type: 'error', code: 'not_a_contact' });
    expect([...db.items.keys()].filter((k) => k.includes('CONTACT#') || k.includes('MSG#'))).toEqual([]);
  });

  it('answers a frame without a body as a bad request instead of failing', async () => {
    await connect(event('c-a', { principalId: alice }));
    expect((await router(event('c-a'))).statusCode).toBe(200);
    expect(posted).toEqual([{ connectionId: 'c-a', event: { type: 'error', code: 'bad_request' } }]);
  });

  it('hands every handler the API and stage the event came in on, to post answers back', async () => {
    await connect(event('c-a', { principalId: alice }));
    await router(event('c-a', { body: JSON.stringify({ action: 'fetch' }) }));
    await disconnect(event('c-a'));
    expect(world.contexts).toHaveLength(3);
    for (const context of world.contexts) {
      expect(context).toMatchObject({ domainName: 'abc123.execute-api.us-west-2.amazonaws.com', stage: 'dev' });
    }
  });
});
