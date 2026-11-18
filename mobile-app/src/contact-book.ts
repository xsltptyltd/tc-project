import * as SecureStore from 'expo-secure-store';
import type { ContactBook } from 'tc-client';
import { storedContactBook } from './stored-book';

/**
 * This phone's contact book, in the platform's secure storage (Android Keystore / iOS
 * Keychain), readable only on this device — like the identity (D20).
 */
export function secureContactBook(): ContactBook {
  return storedContactBook({
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
    delete: (key) => SecureStore.deleteItemAsync(key),
  });
}
