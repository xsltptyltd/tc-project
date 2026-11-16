import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { generateIdentity, init, type Identity } from 'tc-crypto';

const IDENTITY_KEY = 'tc.identity';

/**
 * Loads this device's identity, creating it on first launch.
 * It is kept in the platform's secure storage (Android Keystore / iOS Keychain) and is
 * readable only on this device.
 */
export async function loadOrCreateIdentity(): Promise<Identity> {
  await init({ randomBytes: Crypto.getRandomBytes });

  const stored = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (stored) return JSON.parse(stored) as Identity;

  const identity = generateIdentity();
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return identity;
}
