// A deliberately basic screen: one identity, one person to write to, one list of
// messages. It exists to prove the phone can talk to the backend; the real product
// screens (adding a contact in person, the single thread) are not here yet.
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { TcClient } from 'tc-client';
import type { Identity } from 'tc-crypto';
import { DeviceIdSchema } from 'tc-protocol';
import { loadOrCreateIdentity } from './src/identity';
import { loadSettings, saveSettings } from './src/settings';

type Status = 'starting' | 'offline' | 'connecting' | 'online';

interface Line {
  key: string;
  mine: boolean;
  text: string;
  /** shown under a message of mine: sending, sent, or why it failed */
  note?: string;
}

export default function App() {
  const [identity, setIdentity] = useState<Identity>();
  const [serverUrl, setServerUrl] = useState('');
  const [peerId, setPeerId] = useState('');
  const [status, setStatus] = useState<Status>('starting');
  const [problem, setProblem] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const client = useRef<TcClient | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      try {
        const [loaded, settings] = await Promise.all([loadOrCreateIdentity(), loadSettings()]);
        setIdentity(loaded);
        setServerUrl(settings.serverUrl);
        setPeerId(settings.peerId);
        setStatus('offline');
      } catch (error) {
        setProblem(`Could not start: ${describe(error)}`);
      }
    })();
    return () => void client.current?.close();
  }, []);

  const peer = DeviceIdSchema.safeParse(peerId.trim());

  async function connect() {
    if (!identity) return;
    setProblem(undefined);
    setStatus('connecting');
    const next = new TcClient(identity, serverUrl.trim());
    next.onMessage((message) => {
      setLines((all) => [...all, { key: message.id, mine: false, text: message.text }]);
    });
    next.onClose(() => {
      if (client.current === next) {
        client.current = undefined;
        setStatus('offline');
      }
    });
    try {
      await next.connect();
      client.current = next;
      setStatus('online');
      await saveSettings({ serverUrl: serverUrl.trim(), peerId: peerId.trim() });
    } catch (error) {
      setStatus('offline');
      setProblem(`${describe(error)} — is the server running at ${serverUrl.trim()}?`);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || !peer.success || !client.current) return;
    setDraft('');
    const key = `mine-${Date.now()}`;
    setLines((all) => [...all, { key, mine: true, text, note: 'sending…' }]);
    const note = await client.current.send(peer.data, text).then(
      () => 'sent',
      (error: unknown) => `not sent: ${describe(error)}`,
    );
    setLines((all) => all.map((line) => (line.key === key ? { ...line, note } : line)));
  }

  const online = status === 'online';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.header}>
            <Text style={styles.title}>tap-chat</Text>
            <Text style={[styles.status, online && styles.statusOnline]} testID="status">
              {status}
            </Text>
          </View>

          <Text style={styles.label}>Your id — give it to the other person</Text>
          <View style={styles.row}>
            <Text style={styles.id} selectable testID="device-id">
              {identity?.deviceId ?? '…'}
            </Text>
            <Pressable
              style={styles.smallButton}
              disabled={!identity}
              onPress={() => identity && void Clipboard.setStringAsync(identity.deviceId)}
            >
              <Text style={styles.smallButtonText}>Copy</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>Server</Text>
          <TextInput
            style={styles.input}
            value={serverUrl}
            onChangeText={setServerUrl}
            editable={status === 'offline'}
            autoCapitalize="none"
            autoCorrect={false}
            testID="server-url"
          />

          <Text style={styles.label}>Their id</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={peerId}
              onChangeText={setPeerId}
              placeholder="the other person's id"
              autoCapitalize="none"
              autoCorrect={false}
              testID="peer-id"
            />
            {/* Paste replaces whatever is in the box, so an old id cannot linger. */}
            <Pressable
              style={styles.smallButton}
              onPress={() => void Clipboard.getStringAsync().then((text) => setPeerId(text.trim()))}
              testID="paste-peer-id"
            >
              <Text style={styles.smallButtonText}>Paste</Text>
            </Pressable>
            <Pressable style={styles.smallButton} onPress={() => setPeerId('')} testID="clear-peer-id">
              <Text style={styles.smallButtonText}>Clear</Text>
            </Pressable>
          </View>
          {peerId.trim() !== '' && !peer.success && (
            <Text style={styles.problem}>That does not look like an id.</Text>
          )}

          <Pressable
            style={[styles.button, status === 'connecting' && styles.buttonDisabled]}
            disabled={status === 'starting' || status === 'connecting'}
            onPress={() => (online ? void client.current?.close() : void connect())}
            testID="connect"
          >
            <Text style={styles.buttonText}>
              {online ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : 'Connect'}
            </Text>
          </Pressable>
          {problem && <Text style={styles.problem}>{problem}</Text>}

          <FlatList
            style={styles.flex}
            contentContainerStyle={styles.list}
            data={lines}
            keyExtractor={(line) => line.key}
            renderItem={({ item }) => (
              <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
                <Text style={styles.bubbleText}>{item.text}</Text>
                {item.note && <Text style={styles.note}>{item.note}</Text>}
              </View>
            )}
          />

          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={draft}
              onChangeText={setDraft}
              placeholder={online ? 'Message' : 'Connect to write'}
              editable={online}
              onSubmitEditing={() => void send()}
              testID="draft"
            />
            <Pressable
              style={[styles.smallButton, (!online || !peer.success) && styles.buttonDisabled]}
              disabled={!online || !peer.success}
              onPress={() => void send()}
              testID="send"
            >
              <Text style={styles.smallButtonText}>Send</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  status: { fontSize: 14, color: '#888' },
  statusOnline: { color: '#1a7f37' },
  label: { fontSize: 12, color: '#666', marginTop: 10, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  id: { flex: 1, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  button: { backgroundColor: '#1f4fd8', borderRadius: 8, padding: 12, alignItems: 'center', marginTop: 12 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600' },
  smallButton: { backgroundColor: '#1f4fd8', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  smallButtonText: { color: '#fff', fontWeight: '600' },
  problem: { color: '#b3261e', marginTop: 6, fontSize: 13 },
  list: { paddingVertical: 12, gap: 6 },
  bubble: { maxWidth: '80%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#dbe7ff' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#eee' },
  bubbleText: { fontSize: 15 },
  note: { fontSize: 11, color: '#666', marginTop: 2 },
});
