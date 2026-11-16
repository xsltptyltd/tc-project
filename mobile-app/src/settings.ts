import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SETTINGS_KEY = 'tc.settings';

export interface Settings {
  /** websocket url of the backend */
  serverUrl: string;
  /** device id of the person to write to */
  peerId: string;
}

// The Android emulator reaches the computer it runs on at 10.0.2.2.
// On a real phone, enter the computer's address on the local network.
const DEFAULTS: Settings = {
  serverUrl: Platform.OS === 'android' ? 'ws://10.0.2.2:8787' : 'ws://127.0.0.1:8787',
  peerId: '',
};

export async function loadSettings(): Promise<Settings> {
  const stored = await SecureStore.getItemAsync(SETTINGS_KEY);
  return stored ? { ...DEFAULTS, ...(JSON.parse(stored) as Partial<Settings>) } : DEFAULTS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}
