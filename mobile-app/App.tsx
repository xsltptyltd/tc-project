// The basic app: add someone in person with a code, see who you have, write to them,
// rename them, remove them. Only people added this way can be written to, and only
// their messages are shown (design/DECISIONS.md D19, D20).
//
// Not here yet: the QR code and camera (the code is text for now), and Bluetooth — a
// room, set by hand, stands in for being side by side (src/room.ts).
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  AliasRefused,
  ContactList,
  nameOf,
  NotAContact,
  ProximityUnavailable,
  ServerError,
  TcClient,
  textInvitationCodec,
  type Contact,
  type OpenInvitation,
} from 'tc-client';
import type { Identity } from 'tc-crypto';
import { InitialsSchema } from 'tc-protocol';
import { Button } from './src/Button';
import { ChatScreen, type Line } from './src/ChatScreen';
import { secureContactBook } from './src/contact-book';
import { ContactsScreen } from './src/ContactsScreen';
import { loadOrCreateIdentity } from './src/identity';
import { MeetScreen } from './src/MeetScreen';
import { roomProximity } from './src/room';
import { loadSettings, saveSettings, type Settings } from './src/settings';
import { SettingsScreen } from './src/SettingsScreen';
import { styles } from './src/styles';

type Status = 'starting' | 'offline' | 'connecting' | 'online';

type Screen =
  | { name: 'contacts' }
  | { name: 'chat'; deviceId: string }
  | { name: 'meet' }
  | { name: 'settings' };

export default function App() {
  const [identity, setIdentity] = useState<Identity>();
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<Status>('starting');
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [screen, setScreen] = useState<Screen>({ name: 'contacts' });
  const [contacts, setContacts] = useState<Contact[]>([]);
  // Messages, by the contact they are with. Only in memory: nothing is kept (D9).
  const [threads, setThreads] = useState<Record<string, Line[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<{ invitation: OpenInvitation; until: number }>();
  const [busy, setBusy] = useState(false);

  const client = useRef<TcClient | undefined>(undefined);
  // The keys this phone met in person: the only ones it writes to or shows (D20).
  const book = useRef(secureContactBook()).current;
  const list = useRef(new ContactList(book)).current;
  // What the listeners below need to know, whenever they are called.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const openRef = useRef(open);
  openRef.current = open;

  const refreshContacts = async () => setContacts(await book.list());

  function say(message: { problem?: string; notice?: string }) {
    setProblem(message.problem);
    setNotice(message.notice);
  }

  function closeInvitation() {
    openRef.current?.invitation.close();
    setOpen(undefined);
  }

  function go(next: Screen) {
    if (screenRef.current.name === 'meet' && next.name !== 'meet') closeInvitation();
    if (next.name === 'chat') setUnread(({ [next.deviceId]: _seen, ...rest }) => rest);
    say({});
    setScreen(next);
  }

  useEffect(() => {
    void (async () => {
      try {
        const [loaded, stored] = await Promise.all([loadOrCreateIdentity(), loadSettings()]);
        setIdentity(loaded);
        setSettings(stored);
        await refreshContacts();
        setStatus('offline');
        // Nobody can be added, or add you, without initials: ask for them first.
        if (stored.initials === '') setScreen({ name: 'settings' });
      } catch (error) {
        setProblem(`Could not start: ${describe(error)}`);
      }
    })();
    return () => void client.current?.close();
  }, []);

  // The phone's back button goes back to the contacts, and leaves the app from there.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screenRef.current.name === 'contacts') return false;
      go({ name: 'contacts' });
      return true;
    });
    return () => subscription.remove();
  }, []);

  function change(next: Partial<Settings>) {
    if (!settings) return;
    const updated = { ...settings, ...next };
    setSettings(updated);
    void saveSettings(updated);
  }

  async function connect() {
    if (!identity || !settings) return;
    say({});
    setStatus('connecting');
    const url = settings.serverUrl.trim();
    const next = new TcClient(identity, url, book);
    next.onMessage((message) => {
      setThreads((all) => ({
        ...all,
        [message.from]: [...(all[message.from] ?? []), { key: message.id, mine: false, text: message.text }],
      }));
      const viewing = screenRef.current;
      if (viewing.name !== 'chat' || viewing.deviceId !== message.from) {
        setUnread((all) => ({ ...all, [message.from]: (all[message.from] ?? 0) + 1 }));
      }
    });
    next.onInvitee((invitee) => {
      setOpen(undefined);
      void refreshContacts();
      setScreen({ name: 'contacts' });
      say({ notice: `Added ${invitee.label}.` });
    });
    next.onForgedInvitee(() => {
      say({
        problem:
          'The server reported someone using your code with a key that was not sealed with it. ' +
          'Ignored, and nobody was added. The server may not be honest.',
      });
    });
    next.onContactRemoved((deviceId) => {
      // Dropped quietly: no message to the person (D5). What is on screen just follows.
      void refreshContacts();
      setNotice(undefined); // "Added …" must not outlive the contact
      setThreads(({ [deviceId]: _gone, ...rest }) => rest);
      setUnread(({ [deviceId]: _gone, ...rest }) => rest);
      const viewing = screenRef.current;
      if (viewing.name === 'chat' && viewing.deviceId === deviceId) setScreen({ name: 'contacts' });
    });
    next.onClose(() => {
      if (client.current === next) {
        client.current = undefined;
        setOpen(undefined); // an invitation is forgotten with its connection
        setStatus('offline');
      }
    });
    try {
      await next.connect();
      client.current = next;
      setStatus('online');
      // Drop whoever removed this person while the app was closed (D21).
      if ((await next.syncContacts()) === 'refused') {
        say({
          problem:
            'The server knows none of your contacts. Your list was left as it is; ' +
            'if the server was restarted or replaced, meet again to write to them.',
        });
      }
      await refreshContacts();
    } catch (error) {
      if (client.current === next) return; // connected; only the sync failed
      setStatus('offline');
      setProblem(`${describe(error)} — is the server running at ${url}?`);
    }
  }

  async function invite() {
    const initials = InitialsSchema.safeParse(settings?.initials);
    if (!client.current || !settings || !initials.success) return;
    say({});
    setBusy(true);
    try {
      closeInvitation();
      const invitation = await client.current.invite(initials.data, roomProximity(settings.room));
      setOpen({ invitation, until: Date.now() + invitation.expiresIn * 1000 });
    } catch (error) {
      say({ problem: describe(error) });
    } finally {
      setBusy(false);
    }
  }

  async function accept(code: string) {
    const initials = InitialsSchema.safeParse(settings?.initials);
    if (!client.current || !settings || !initials.success) return;
    const invitation = textInvitationCodec.decode(code);
    if (!invitation) {
      say({ problem: 'That is not a code. Copy the whole code, starting with “tc1.”' });
      return;
    }
    say({});
    setBusy(true);
    try {
      const inviter = await client.current.accept(invitation, initials.data, roomProximity(settings.room));
      await refreshContacts();
      setScreen({ name: 'contacts' });
      say({ notice: `Added ${inviter.label}.` });
    } catch (error) {
      const refused = error instanceof ServerError && error.code === 'invitation_invalid';
      say({
        problem: refused
          ? 'That code cannot be used: you are not in the same room as them, or it expired, or it was already used.'
          : describe(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function send(to: string, text: string) {
    if (!client.current) return;
    const key = `mine-${Date.now()}-${Math.random()}`;
    const update = (note: string) =>
      setThreads((all) => ({
        ...all,
        [to]: (all[to] ?? []).map((line) => (line.key === key ? { ...line, note } : line)),
      }));
    setThreads((all) => ({ ...all, [to]: [...(all[to] ?? []), { key, mine: true, text, note: 'sending…' }] }));
    try {
      await client.current.send(to, text);
      // Accepted by the server, and nothing more: never "delivered" or "read" (D14).
      update('sent');
    } catch (error) {
      const stranger =
        error instanceof NotAContact || (error instanceof ServerError && error.code === 'not_a_contact');
      update(stranger ? 'not sent: not one of your contacts — meet again to add each other' : `not sent: ${describe(error)}`);
    }
  }

  async function setAlias(deviceId: string, alias: string | undefined): Promise<string | undefined> {
    try {
      await list.setAlias(deviceId, alias);
      await refreshContacts();
      return undefined;
    } catch (error) {
      if (error instanceof AliasRefused) return error.message;
      throw error;
    }
  }

  async function remove(contact: Contact) {
    if (!client.current) return;
    try {
      await client.current.removeContact(contact.deviceId);
      setThreads(({ [contact.deviceId]: _gone, ...rest }) => rest);
      await refreshContacts();
      setScreen({ name: 'contacts' });
      say({ notice: `Removed ${nameOf(contact)}. You are no longer contacts, on either side.` });
    } catch (error) {
      say({ problem: `Not removed: ${describe(error)}` });
    }
  }

  const online = status === 'online';
  const chatting = screen.name === 'chat' ? contacts.find((c) => c.deviceId === screen.deviceId) : undefined;
  const title =
    screen.name === 'contacts'
      ? 'tap-chat'
      : screen.name === 'meet'
        ? 'Add someone'
        : screen.name === 'settings'
          ? 'Settings'
          : chatting
            ? nameOf(chatting)
            : '';

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.header}>
            {screen.name !== 'contacts' && (
              <Button title="‹ Back" kind="quiet" onPress={() => go({ name: 'contacts' })} testID="back" />
            )}
            <View style={styles.flex}>
              <Text style={styles.title} numberOfLines={1} testID="title">
                {title}
              </Text>
              {screen.name === 'contacts' && settings?.initials !== '' && (
                <Text style={styles.subtitle}>you are {settings?.initials}</Text>
              )}
              {chatting?.alias !== undefined && <Text style={styles.subtitle}>{chatting.label}</Text>}
            </View>
            <Text style={[styles.status, online && styles.statusOnline]} testID="status">
              {status}
            </Text>
          </View>

          {screen.name === 'contacts' && (
            <View style={styles.row}>
              <Button
                title={online ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : 'Connect'}
                disabled={status === 'starting' || status === 'connecting'}
                onPress={() => (online ? void client.current?.close() : void connect())}
                testID="connect"
              />
              <Button title="Settings" kind="quiet" onPress={() => go({ name: 'settings' })} testID="settings" />
            </View>
          )}
          {problem && (
            <Text style={styles.problem} testID="problem">
              {problem}
            </Text>
          )}
          {notice && (
            <Text style={styles.notice} testID="notice">
              {notice}
            </Text>
          )}

          {screen.name === 'contacts' && (
            <ContactsScreen
              contacts={contacts}
              unread={unread}
              online={online}
              onOpen={(contact) => go({ name: 'chat', deviceId: contact.deviceId })}
              onAdd={() => go({ name: 'meet' })}
            />
          )}
          {screen.name === 'meet' && settings && (
            <MeetScreen
              online={online}
              initials={settings.initials}
              room={settings.room}
              onRoomChange={(room) => change({ room })}
              open={open}
              onInvite={() => void invite()}
              onAccept={(code) => void accept(code)}
              busy={busy}
            />
          )}
          {screen.name === 'settings' && settings && (
            <SettingsScreen
              deviceId={identity?.deviceId}
              initials={settings.initials}
              onInitialsChange={(initials) => change({ initials })}
              serverUrl={settings.serverUrl}
              onServerUrlChange={(serverUrl) => change({ serverUrl })}
              offline={status === 'offline'}
            />
          )}
          {screen.name === 'chat' && chatting && (
            <ChatScreen
              key={chatting.deviceId}
              contact={chatting}
              lines={threads[chatting.deviceId] ?? []}
              online={online}
              onSend={(text) => void send(chatting.deviceId, text)}
              onTakeBack={() => client.current?.unsend(chatting.deviceId)}
              onAlias={(alias) => setAlias(chatting.deviceId, alias)}
              onRemove={() => void remove(chatting)}
            />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
