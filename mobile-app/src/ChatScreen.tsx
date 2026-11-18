// One conversation. Messages live only in this app's memory, for as long as it runs:
// the backend deleted each one when it was received (design/DECISIONS.md D9).
import { useState } from 'react';
import { Alert, FlatList, Text, TextInput, View } from 'react-native';
import { nameOf, type Contact } from 'tc-client';
import { Button } from './Button';
import { styles } from './styles';

export interface Line {
  key: string;
  mine: boolean;
  text: string;
  /** shown under a message of mine: sending, sent, or why it failed */
  note?: string;
}

export function ChatScreen(props: {
  contact: Contact;
  lines: Line[];
  online: boolean;
  onSend(text: string): void;
  /** Take back what they have not received yet (D17). */
  onTakeBack(): void;
  /** `undefined` goes back to the label. Resolves an explanation if the alias is refused. */
  onAlias(alias: string | undefined): Promise<string | undefined>;
  onRemove(): void;
}) {
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [alias, setAlias] = useState(props.contact.alias ?? '');
  const [aliasProblem, setAliasProblem] = useState<string>();
  const [tookBack, setTookBack] = useState(false);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setTookBack(false);
    props.onSend(text);
  }

  async function saveAlias(next: string | undefined) {
    const problem = await props.onAlias(next);
    setAliasProblem(problem);
    if (!problem) setRenaming(false);
  }

  function confirmRemove() {
    Alert.alert(
      `Remove ${nameOf(props.contact)}?`,
      'You will no longer be contacts, on either side, and messages waiting between you are deleted. ' +
        'To write to each other again you must meet again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: props.onRemove },
      ],
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.wrap}>
        <Button title="Rename" kind="quiet" onPress={() => setRenaming(!renaming)} testID="rename" />
        <Button
          title="Take back"
          kind="quiet"
          disabled={!props.online}
          onPress={() => {
            props.onTakeBack();
            setTookBack(true);
          }}
          testID="take-back"
        />
        <Button title="Remove" kind="danger" disabled={!props.online} onPress={confirmRemove} testID="remove" />
      </View>
      {tookBack && <Text style={styles.help}>Deleted whatever they had not received yet.</Text>}
      {renaming && (
        <View>
          <Text style={styles.label}>Your name for them, on this phone only</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={alias}
              onChangeText={setAlias}
              placeholder={props.contact.label}
              testID="alias"
            />
            <Button title="Save" disabled={alias.trim() === ''} onPress={() => void saveAlias(alias)} testID="save-alias" />
            {props.contact.alias !== undefined && (
              <Button
                title={`Back to ${props.contact.label}`}
                kind="quiet"
                onPress={() => {
                  setAlias('');
                  void saveAlias(undefined);
                }}
                testID="clear-alias"
              />
            )}
          </View>
          {aliasProblem && <Text style={styles.problem}>{aliasProblem}</Text>}
        </View>
      )}

      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={props.lines}
        keyExtractor={(line) => line.key}
        ListEmptyComponent={<Text style={styles.empty}>No messages. Nothing is kept once the app is closed.</Text>}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
            <Text style={styles.bubbleText}>{item.text}</Text>
            {item.note && <Text style={styles.note}>{item.note}</Text>}
          </View>
        )}
      />

      <View style={[styles.row, { paddingBottom: 8 }]}>
        <TextInput
          style={[styles.input, styles.flex]}
          value={draft}
          onChangeText={setDraft}
          placeholder={props.online ? 'Message' : 'Connect to write'}
          editable={props.online}
          onSubmitEditing={send}
          testID="draft"
        />
        <Button title="Send" disabled={!props.online || draft.trim() === ''} onPress={send} testID="send" />
      </View>
    </View>
  );
}
