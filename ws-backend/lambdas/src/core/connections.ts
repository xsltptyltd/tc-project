import type { DeviceId } from 'tc-protocol';
import type { Deps } from './ports';

export async function onConnect(deps: Deps, connectionId: string, deviceId: DeviceId): Promise<void> {
  await deps.store.putConnection({ connectionId, deviceId, connectedAt: deps.now() });
}

export async function onDisconnect(deps: Deps, connectionId: string): Promise<void> {
  await deps.store.deleteConnection(connectionId);
}
