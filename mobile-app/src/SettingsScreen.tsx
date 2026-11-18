// Who this person is to others — only their initials (design/DECISIONS.md D13) — and
// which server the app talks to.
import * as Clipboard from 'expo-clipboard';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { INITIALS_MAX_LENGTH } from 'tc-protocol';
import { Button } from './Button';
import { styles } from './styles';

export function SettingsScreen(props: {
  deviceId?: string;
  initials: string;
  onInitialsChange(initials: string): void;
  serverUrl: string;
  onServerUrlChange(url: string): void;
  /** The server can only be changed while disconnected. */
  offline: boolean;
}) {
  return (
    <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Your initials — 1 to {INITIALS_MAX_LENGTH} letters, all anyone sees of your name</Text>
      <TextInput
        style={styles.input}
        value={props.initials}
        // Letters A to Z only, upper case, as the backend requires.
        onChangeText={(typed) =>
          props.onInitialsChange(typed.toUpperCase().replace(/[^A-Z]/g, '').slice(0, INITIALS_MAX_LENGTH))
        }
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={INITIALS_MAX_LENGTH}
        placeholder="AZ"
        testID="initials"
      />

      <Text style={styles.label}>Server</Text>
      <TextInput
        style={styles.input}
        value={props.serverUrl}
        onChangeText={props.onServerUrlChange}
        editable={props.offline}
        autoCapitalize="none"
        autoCorrect={false}
        testID="server-url"
      />
      {!props.offline && <Text style={styles.help}>Disconnect to change the server.</Text>}

      <Text style={styles.label}>This device's id — for development; people are added with a code, not with this</Text>
      <View style={styles.row}>
        <Text style={[styles.code, styles.flex]} selectable testID="device-id">
          {props.deviceId ?? '…'}
        </Text>
        <Button
          title="Copy"
          kind="quiet"
          disabled={!props.deviceId}
          onPress={() => props.deviceId && void Clipboard.setStringAsync(props.deviceId)}
        />
      </View>
    </ScrollView>
  );
}
