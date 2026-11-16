import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { authSigningString, formatAuthToken, type ServerEvent } from 'tc-protocol';
import { MemoryStore } from '../src/adapters/memory-store';
import type { Deps } from '../src/core/ports';

export interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
}

export function newDevice(): TestDevice {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // The JWK "x" field is the raw public key in base64url, which is exactly a device id.
  return { deviceId: publicKey.export({ format: 'jwk' }).x as string, privateKey };
}

export function authToken(device: TestDevice, ts: number, claimedId = device.deviceId): string {
  const sig = sign(null, Buffer.from(authSigningString(claimedId, ts)), device.privateKey);
  return formatAuthToken({ deviceId: claimedId, ts, sig: sig.toString('base64url') });
}

/** Deps with an in-memory store and a transport that records what was posted. */
export function testDeps(now = 1_800_000_000) {
  const store = new MemoryStore();
  const posted: Array<{ connectionId: string; event: ServerEvent }> = [];
  const gone = new Set<string>();
  let nextId = 1;
  const deps: Deps = {
    store,
    now: () => now,
    newId: () => `m${nextId++}`,
    transport: {
      async post(connectionId, event) {
        if (gone.has(connectionId)) return false;
        posted.push({ connectionId, event });
        return true;
      },
    },
  };
  const eventsFor = (connectionId: string) =>
    posted.filter((p) => p.connectionId === connectionId).map((p) => p.event);
  return { deps, store, posted, gone, eventsFor };
}
