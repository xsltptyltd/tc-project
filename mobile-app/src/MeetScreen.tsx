// Adding someone in person (design/DECISIONS.md D1, D18). One person shows a code, the
// other uses it; both must be in the same room, which stands in for Bluetooth proximity
// until that is built. The code is text for now — the QR code comes with the camera.
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { textInvitationCodec, type OpenInvitation } from 'tc-client';
import { Button } from './Button';
import { styles } from './styles';

export function MeetScreen(props: {
  online: boolean;
  initials: string;
  room: string;
  onRoomChange(room: string): void;
  /** The invitation being shown, if any, and when it stops working (ms). */
  open?: { invitation: OpenInvitation; until: number };
  onInvite(): void;
  onAccept(code: string): void;
  busy: boolean;
}) {
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const left = props.open ? Math.max(0, Math.ceil((props.open.until - now) / 1000)) : 0;
  const shown = props.open && left > 0 ? textInvitationCodec.encode(props.open.invitation.invitation) : undefined;
  const ready = props.online && props.initials !== '' && !props.busy;

  return (
    <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Room — the same on both devices</Text>
      <TextInput
        style={styles.input}
        value={props.room}
        onChangeText={props.onRoomChange}
        editable={!shown}
        autoCapitalize="none"
        autoCorrect={false}
        testID="room"
      />
      <Text style={styles.help}>
        Stands in for being side by side until Bluetooth is built. It is never sent to the server.
      </Text>
      {!props.online && <Text style={styles.problem}>Connect first: adding someone needs the server.</Text>}
      {props.initials === '' && <Text style={styles.problem}>Set your initials first, in Settings.</Text>}

      <Text style={styles.sectionTitle}>Show my code</Text>
      {shown ? (
        <View>
          <Text style={styles.help}>
            Valid {left} s. They enter it under “Use their code”, in room {props.room.trim()}.
          </Text>
          <Text style={[styles.code, { marginTop: 8 }]} selectable testID="my-code">
            {shown}
          </Text>
          <View style={styles.wrap}>
            <Button title="Copy" onPress={() => void Clipboard.setStringAsync(shown)} testID="copy-code" />
          </View>
        </View>
      ) : (
        <View style={styles.wrap}>
          <Button
            title={props.open ? 'Expired — show a new code' : 'Show a code'}
            disabled={!ready}
            onPress={props.onInvite}
            testID="show-code"
          />
        </View>
      )}

      <Text style={styles.sectionTitle}>Use their code</Text>
      <TextInput
        style={[styles.input, { marginTop: 8 }]}
        value={code}
        onChangeText={setCode}
        placeholder="tc1.…"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        testID="their-code"
      />
      <View style={styles.wrap}>
        {/* Paste replaces whatever is in the box, so an old code cannot linger. */}
        <Button
          title="Paste"
          kind="quiet"
          onPress={() => void Clipboard.getStringAsync().then((text) => setCode(text.trim()))}
          testID="paste-code"
        />
        <Button title="Clear" kind="quiet" onPress={() => setCode('')} testID="clear-code" />
        <Button
          title="Add them"
          disabled={!ready || code.trim() === ''}
          onPress={() => props.onAccept(code)}
          testID="accept-code"
        />
      </View>
    </ScrollView>
  );
}
