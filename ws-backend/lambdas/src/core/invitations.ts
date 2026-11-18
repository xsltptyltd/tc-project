// Invitations: the part of adding someone in person that goes through the backend
// (design/DECISIONS.md D1, D18). The backend holds an invitation for a few seconds, lets
// one device accept it — which makes the two contacts (D19) — and relays that device to
// the inviter. It never sees the key, so it cannot tell a code accepted from the wrong
// place from one that does not exist, and it cannot change who accepted without the
// inviter noticing (the MAC).
import type { DeviceId, Initials } from 'tc-protocol';
import type { Deps } from './ports';

export async function invite(
  deps: Deps,
  connectionId: string,
  inviter: DeviceId,
  tokenId: string,
  initials: Initials,
): Promise<void> {
  // The inviter is taken from the connection, never from the frame.
  const stored = await deps.contacts.putInvitation({
    tokenId,
    inviter,
    initials,
    expiresAt: deps.now() + deps.invitationTtlSeconds,
  });
  await deps.transport.post(
    connectionId,
    stored
      ? { type: 'invited', tokenId, expiresIn: deps.invitationTtlSeconds }
      : { type: 'error', code: 'invitation_invalid' },
  );
}

export async function accept(
  deps: Deps,
  connectionId: string,
  invitee: DeviceId,
  frame: { tokenId: string; inviter: DeviceId; initials: Initials; mac: string },
): Promise<void> {
  // Nobody adds themselves. Refused before it can use the invitation up.
  const accepted =
    invitee === frame.inviter
      ? undefined
      : await deps.contacts.acceptInvitation(frame.tokenId, { inviter: frame.inviter, invitee }, deps.now());
  if (!accepted) {
    // Unknown, expired, already accepted or someone else's: the same answer for all.
    await deps.transport.post(connectionId, { type: 'error', code: 'invitation_invalid' });
    return;
  }

  // They are contacts from here on. The answer does not depend on whether the inviter is
  // connected (D14).
  await deps.transport.post(connectionId, {
    type: 'accepted',
    inviter: accepted.inviter,
    initials: accepted.initials,
  });

  // The invitee is taken from the connection; the initials and MAC are relayed untouched
  // for the inviter to check.
  const event = { type: 'invitee', tokenId: frame.tokenId, invitee, initials: frame.initials, mac: frame.mac } as const;
  for (const target of await deps.store.listConnections(accepted.inviter)) {
    const reached = await deps.transport.post(target.connectionId, event);
    if (!reached) await deps.store.deleteConnection(target.connectionId);
  }
}
