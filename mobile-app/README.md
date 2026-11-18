# mobile-app

The React Native (Expo) app. Built and tested on Android; iOS is kept possible but
unproven (`design/DECISIONS.md` D12).

What exists is basic: enough to add someone, see who you have, and write to them.

- **Settings:** your initials (1 to 4 letters, all anyone sees of your name) and the
  server address. Asked on first launch.
- **Contacts:** the people this phone met in person, by alias or label (`BB2`), with a
  count of unread messages. Only they can be written to, and only their messages are
  shown (`design/DECISIONS.md` D19, D20).
- **Add someone:** one person shows a code, the other enters it. Both must be in the
  same room (below).
- **Chat:** one conversation per contact, kept in memory only; rename (an alias, on this
  phone only), take back what they have not received yet, remove.

Not built: the QR code and camera — the code is text, copied and pasted — and
Bluetooth. **A room stands in for being side by side:** a field on the "Add someone"
screen, `1` by default, so everyone is in the same room unless it is changed. It is the
terminal's `TC_ROOM`: a phone in room `1` and `TC_ROOM=1 npm run cli -- invite alice` can
add each other. The room is never sent to the server. Bluetooth will replace it behind
the same interface (`Proximity` in `tc-client`), without changing the screens.

```
App.tsx                 state, connection, and which screen is shown
src/ContactsScreen.tsx  the list
src/MeetScreen.tsx      show a code / use a code
src/ChatScreen.tsx      one conversation
src/SettingsScreen.tsx  initials, server
src/room.ts             the room, as a Proximity
src/contact-book.ts     the contact book in secure storage
src/stored-book.ts      how it is laid out there (tested: test/stored-book.test.ts)
src/identity.ts         create / load the identity (secure storage)
src/settings.ts         remembered server address, initials and room
```

The encryption and connection code are the shared `tc-crypto` and `tc-client` packages.

## Run it on Android

You need the Android SDK with an emulator, or a phone with USB debugging. The app runs
inside Expo Go, which is installed on the device automatically the first time.

The app has its own install, separate from the rest of the repository. From the
repository root, once:

```
npm install                        # the shared code
npm --prefix mobile-app install    # the app
```

Then, in two terminals:

```
npm run dev:server                 # the backend, on this computer
npm run app -- --android           # builds the app and opens it on the emulator/phone
```

- **Emulator:** the default server address `ws://10.0.2.2:8787` is this computer as seen
  from the emulator. Nothing to change.
- **Real phone:** start the server with `HOST=0.0.0.0 npm run dev:server`, and in the app
  set the server to `ws://<this computer's address on the wifi>:8787`.

To talk to it, use the command-line client (`cli/README.md`). In the app: set your
initials, press Connect, then "Add someone". Either side can show the code.

```
npm run cli -- init alice
npm run cli -- initials alice AZ

# the terminal shows a code; paste it in the app under "Use their code", room 1
TC_ROOM=1 npm run cli -- invite alice

# or the app shows a code ("Show a code"); use it from the terminal
TC_ROOM=1 npm run cli -- accept alice <code>

npm run cli -- chat alice --to <your initials, as alice's list shows them>
```

Text copied on the computer can be pasted in the emulator, and the other way round.
`INVITATION_TTL_SECONDS=120 npm run dev:server` leaves two minutes to copy a code
instead of twenty seconds.

`ios/` and `android/` folders are not in the repository; nothing here needs them yet.
