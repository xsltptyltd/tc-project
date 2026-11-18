import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SETTINGS_KEY = 'tc.settings';

export interface Settings {
  /** websocket url of the backend */
  serverUrl: string;
  /** This person's initials, 1 to 4 letters; empty until they are set (D13). */
  initials: string;
  /**
   * The room this phone is in: the stand-in for Bluetooth proximity until that is built
   * (D18). Two devices can add each other only with the same room. Never sent anywhere.
   */
  room: string;
}

// The Android emulator reaches the computer it runs on at 10.0.2.2.
// On a real phone, enter the computer's address on the local network.
const DEFAULTS: Settings = {
  serverUrl: Platform.OS === 'android' ? 'ws://10.0.2.2:8787' : 'ws://127.0.0.1:8787',
  initials: '',
  // Everyone starts in the same room, so adding works without touching this.
  room: '1',
};

export async function loadSettings(): Promise<Settings> {
  const stored = await SecureStore.getItemAsync(SETTINGS_KEY);
  if (!stored) return DEFAULTS;
  const { serverUrl, initials, room } = JSON.parse(stored) as Partial<Settings>;
  return {
    serverUrl: serverUrl ?? DEFAULTS.serverUrl,
    initials: initials ?? DEFAULTS.initials,
    room: room ?? DEFAULTS.room,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
}
