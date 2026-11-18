// The first screen: who this person can write to. Only people met in person are here
// (design/DECISIONS.md D20), shown by alias or label (D13).
import { FlatList, Pressable, Text, View } from 'react-native';
import { byName, nameOf, type Contact } from 'tc-client';
import { Button } from './Button';
import { styles } from './styles';

export function ContactsScreen(props: {
  contacts: Contact[];
  /** Messages received and not looked at yet, by device id. */
  unread: Record<string, number>;
  online: boolean;
  onOpen(contact: Contact): void;
  onAdd(): void;
}) {
  return (
    <View style={styles.flex}>
      <View style={styles.row}>
        <Text style={[styles.sectionTitle, styles.flex]}>Contacts</Text>
        <Button title="Add someone" onPress={props.onAdd} testID="add-someone" />
      </View>
      <FlatList
        style={styles.flex}
        data={byName(props.contacts)}
        keyExtractor={(contact) => contact.deviceId}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nobody yet. You can only write to people you added in person: press “Add someone” when you are
            together.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.contact} onPress={() => props.onOpen(item)} testID={`contact-${nameOf(item)}`}>
            <View style={styles.flex}>
              <Text style={styles.contactName}>{nameOf(item)}</Text>
              {item.alias !== undefined && <Text style={styles.contactLabel}>{item.label}</Text>}
            </View>
            {(props.unread[item.deviceId] ?? 0) > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{props.unread[item.deviceId]}</Text>
              </View>
            )}
          </Pressable>
        )}
      />
      {!props.online && <Text style={styles.help}>Offline: connect to receive and send.</Text>}
    </View>
  );
}
