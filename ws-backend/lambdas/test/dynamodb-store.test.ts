// How connections, messages, contacts and invitations are shaped into items and keys, which is where a quiet
// mistake (a wrong prefix, an unpadded number) would corrupt the table. What the store
// then does with them is in store-contract.test.ts.
import { describe, expect, it } from 'vitest';
import { MESSAGE_TTL_SECONDS, type Envelope } from 'tc-protocol';
import {
  CONNECTION_SWEEP_SECONDS,
  connectionFrom,
  connectionItem,
  connectionKey,
  contactItem,
  contactKey,
  invitationFrom,
  invitationItem,
  invitationKey,
  deviceConnectionItem,
  deviceConnectionKey,
  envelopeFrom,
  envelopesOldestFirst,
  messageItem,
  messageKey,
} from '../src/adapters/dynamodb-store';
import { newDevice } from './helpers';

const alice = newDevice().deviceId;
const bob = newDevice().deviceId;

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  id: 'm1',
  from: alice,
  to: bob,
  ciphertext: 'c2VjcmV0',
  sentAt: 1_800_000_000,
  expiresAt: 1_800_000_000 + MESSAGE_TTL_SECONDS,
  ...over,
});

describe('message items', () => {
  it('carry the whole envelope back out', () => {
    expect(envelopeFrom(messageItem(envelope()))).toEqual(envelope());
  });

  it('sit in the receiver’s partition, not the sender’s', () => {
    const item = messageItem(envelope());
    expect(item.PK).toBe(`DEVICE#${bob}`);
    expect(item.PK).not.toContain(alice);
  });

  it('can be found from the receiver and the id alone — all an ack carries', () => {
    const item = messageItem(envelope());
    expect(messageKey(bob, 'm1')).toEqual({ PK: item.PK, SK: item.SK });
  });

  it('cannot be reached by anyone but the receiver', () => {
    const item = messageItem(envelope());
    expect(messageKey(alice, 'm1')).not.toEqual({ PK: item.PK, SK: item.SK });
  });

  it('come back oldest first, whatever order their ids put them in', () => {
    const items = [
      messageItem(envelope({ id: 'a', sentAt: 1_000_000_000 })),
      messageItem(envelope({ id: 'b', sentAt: 999_999_999 })),
      messageItem(envelope({ id: 'c', sentAt: 1_000_000_001 })),
    ];
    expect(envelopesOldestFirst(items).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('hand DynamoDB’s TTL the expiry time, which is what makes DynamoDB delete them', () => {
    expect(messageItem(envelope()).ttl).toBe(envelope().expiresAt);
    const oneSecond = envelope({ sentAt: 1_800_000_000, expiresAt: 1_800_000_001 });
    expect(messageItem(oneSecond).ttl).toBe(1_800_000_001);
  });
});

describe('connection items', () => {
  const connection = { connectionId: 'conn-1', deviceId: alice, connectedAt: 1_800_000_000 };

  it('are keyed by connection id alone — all a $disconnect event carries', () => {
    const item = connectionItem(connection);
    expect(connectionKey('conn-1')).toEqual({ PK: item.PK, SK: item.SK });
    expect(item.PK).toBe('CONNECTION#conn-1');
  });

  it('are filed a second time under their device, on the base table', () => {
    const item = deviceConnectionItem(connection);
    expect(deviceConnectionKey(alice, 'conn-1')).toEqual({ PK: item.PK, SK: item.SK });
    expect(item.PK).toBe(`DEVICE#${alice}`);
    expect(item.SK).toBe('CONNECTION#conn-1');
    expect(connectionFrom(item)).toEqual(connection);
  });

  it('round-trip', () => {
    expect(connectionFrom(connectionItem(connection))).toEqual(connection);
  });

  it('outlive the longest websocket API Gateway allows, then get swept', () => {
    const item = connectionItem(connection);
    expect(item.ttl - connection.connectedAt).toBe(CONNECTION_SWEEP_SECONDS);
    expect(CONNECTION_SWEEP_SECONDS).toBeGreaterThan(2 * 60 * 60);
  });
});

describe('contact items', () => {
  it('sit in their owner’s partition, one per side, beside its connections and messages', () => {
    expect(contactKey(alice, bob)).toEqual({ PK: `DEVICE#${alice}`, SK: `CONTACT#${bob}` });
    expect(contactKey(bob, alice)).toEqual({ PK: `DEVICE#${bob}`, SK: `CONTACT#${alice}` });
    expect(contactItem(alice, bob)).toMatchObject(contactKey(alice, bob));
  });

  it('never share a sort key prefix with a connection or a message in the same partition', () => {
    const sk = contactKey(alice, bob).SK;
    expect(sk.startsWith('CONNECTION#')).toBe(false);
    expect(sk.startsWith('MSG#')).toBe(false);
    expect(deviceConnectionKey(alice, 'c').SK.startsWith('CONTACT#')).toBe(false);
    expect(messageKey(alice, 'm').SK.startsWith('CONTACT#')).toBe(false);
  });

  it('hold who and whom, and nothing else — no names, no expiry: a contact lasts until removed', () => {
    expect(contactItem(alice, bob)).toEqual({ ...contactKey(alice, bob), owner: alice, contact: bob });
  });
});

describe('invitation items', () => {
  const invitation = { tokenId: 'T'.repeat(43), inviter: alice, initials: 'AZ', expiresAt: 1_800_000_020 };

  it('are found by token id alone — all an acceptance carries', () => {
    expect(invitationKey('T'.repeat(43))).toEqual({ PK: `INVITATION#${'T'.repeat(43)}`, SK: 'INVITATION' });
    expect(invitationItem(invitation)).toMatchObject(invitationKey(invitation.tokenId));
  });

  it('round-trip, accepted or not', () => {
    expect(invitationFrom(invitationItem(invitation))).toEqual(invitation);
    const accepted = { ...invitation, acceptedBy: bob };
    expect(invitationFrom(invitationItem(accepted))).toEqual(accepted);
  });

  it('hand DynamoDB’s TTL their expiry, so they are deleted without anyone asking', () => {
    expect(invitationItem(invitation).ttl).toBe(invitation.expiresAt);
  });
});
