import { ClientActionSchema, type DeviceId, type Envelope } from 'tc-protocol';
import { listContacts, removeContact } from './contacts';
import { accept, invite } from './invitations';
import type { Deps } from './ports';

/** Handles one frame received on an open connection. */
export async function onMessage(deps: Deps, connectionId: string, body: string): Promise<void> {
  const connection = await deps.store.getConnection(connectionId);
  if (!connection) {
    await deps.transport.post(connectionId, { type: 'error', code: 'unknown_connection' });
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  const parsed = ClientActionSchema.safeParse(json);
  if (!parsed.success) {
    await deps.transport.post(connectionId, { type: 'error', code: 'bad_request' });
    return;
  }

  const action = parsed.data;
  switch (action.action) {
    case 'send':
      await send(deps, connectionId, connection.deviceId, action.to, action.ciphertext);
      return;
    case 'ack':
      // The receiver comes from the connection, so nobody can delete someone else's
      // message. No answer either way, and the sender is not told (D9, D14).
      await deps.store.deleteMessage(connection.deviceId, action.messageId);
      return;
    case 'fetch':
      await fetchWaiting(deps, connectionId, connection.deviceId);
      return;
    case 'unsend':
      // The sender comes from the connection: nobody can take back someone else's
      // message. No answer, whatever was deleted (D14, D17).
      await deps.store.unsendMessages(connection.deviceId, action.to, action.messageId);
      return;
    case 'invite':
      await invite(deps, connectionId, connection.deviceId, action.tokenId, action.initials);
      return;
    case 'accept':
      await accept(deps, connectionId, connection.deviceId, action);
      return;
    case 'remove':
      await removeContact(deps, connectionId, connection.deviceId, action.contact);
      return;
    case 'contacts':
      await listContacts(deps, connectionId, connection.deviceId);
      return;
  }
}

/**
 * Delivers, to this connection only, the messages that arrived while the device was
 * offline. Delivering does not delete: the device acknowledges what it received (D9),
 * and anything it did not acknowledge comes again on the next fetch, until it expires.
 */
async function fetchWaiting(deps: Deps, connectionId: string, deviceId: DeviceId): Promise<void> {
  for (const envelope of await deps.store.listMessages(deviceId, deps.now())) {
    // Taken back by its sender since it was listed: it must not be delivered.
    if (!(await deps.store.markDelivered(deviceId, envelope.id))) continue;
    const reached = await deps.transport.post(connectionId, { type: 'message', envelope });
    if (!reached) {
      await deps.store.deleteConnection(connectionId);
      return;
    }
  }
}

async function send(
  deps: Deps,
  connectionId: string,
  from: DeviceId,
  to: DeviceId,
  ciphertext: string,
): Promise<void> {
  // Only to a contact (D19). Refused before anything is stored.
  if (!(await deps.contacts.isContact(from, to))) {
    await deps.transport.post(connectionId, { type: 'error', code: 'not_a_contact' });
    return;
  }

  const sentAt = deps.now();
  // The sender is taken from the authenticated connection, never from the frame.
  const envelope: Envelope = {
    id: deps.newId(),
    from,
    to,
    ciphertext,
    sentAt,
    expiresAt: sentAt + deps.messageTtlSeconds,
  };
  await deps.store.putMessage(envelope);

  // The sender learns that the message was accepted, and nothing else: the answer is the
  // same, and is sent before any delivery attempt, whether or not the receiver is online.
  await deps.transport.post(connectionId, { type: 'sent', messageId: envelope.id });

  const targets = await deps.store.listConnections(to);
  // Marked before it is posted, so the sender can never take back something the receiver
  // may already have — even if, in the end, no connection was still there to take it.
  if (targets.length === 0 || !(await deps.store.markDelivered(to, envelope.id))) return;
  for (const target of targets) {
    const reached = await deps.transport.post(target.connectionId, { type: 'message', envelope });
    if (!reached) await deps.store.deleteConnection(target.connectionId);
  }
}
