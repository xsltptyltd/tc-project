// Ending a contact, and telling a device who its contacts are (design/DECISIONS.md D5,
// D21). Either side can end it, for both; the other is not told, their device just drops
// the contact.
import type { DeviceId } from 'tc-protocol';
import type { Deps } from './ports';

export async function removeContact(
  deps: Deps,
  connectionId: string,
  owner: DeviceId,
  contact: DeviceId,
): Promise<void> {
  // The one removing is taken from the connection: nobody ends someone else's contacts.
  // Contact first, so nothing new can be sent between them while the messages go.
  await deps.contacts.removeContact(owner, contact);
  await deps.store.deleteMessagesBetween(owner, contact);
  // The same answer whether or not they were contacts.
  await deps.transport.post(connectionId, { type: 'removed', contact });

  // Every device on both sides drops it now; one offline does so on its next sync.
  for (const [to, removed] of [[contact, owner], [owner, contact]] as const) {
    for (const target of await deps.store.listConnections(to)) {
      const reached = await deps.transport.post(target.connectionId, { type: 'contact_removed', contact: removed });
      if (!reached) await deps.store.deleteConnection(target.connectionId);
    }
  }
}

export async function listContacts(deps: Deps, connectionId: string, owner: DeviceId): Promise<void> {
  await deps.transport.post(connectionId, { type: 'contacts', contacts: await deps.contacts.listContacts(owner) });
}
