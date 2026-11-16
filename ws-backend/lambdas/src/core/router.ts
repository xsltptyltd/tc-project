import { ClientActionSchema, MESSAGE_TTL_SECONDS, type DeviceId, type Envelope } from 'tc-protocol';
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
      await deps.transport.post(connectionId, { type: 'error', code: 'not_implemented' });
      return;
  }
}

async function send(
  deps: Deps,
  connectionId: string,
  from: DeviceId,
  to: DeviceId,
  ciphertext: string,
): Promise<void> {
  const sentAt = deps.now();
  // The sender is taken from the authenticated connection, never from the frame.
  const envelope: Envelope = {
    id: deps.newId(),
    from,
    to,
    ciphertext,
    sentAt,
    expiresAt: sentAt + MESSAGE_TTL_SECONDS,
  };
  await deps.store.putMessage(envelope);

  // The sender learns that the message was accepted, and nothing else: the answer is the
  // same, and is sent before any delivery attempt, whether or not the receiver is online.
  await deps.transport.post(connectionId, { type: 'sent', messageId: envelope.id });

  for (const target of await deps.store.listConnections(to)) {
    const reached = await deps.transport.post(target.connectionId, { type: 'message', envelope });
    if (!reached) await deps.store.deleteConnection(target.connectionId);
  }
}
