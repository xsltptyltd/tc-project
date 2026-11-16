# mobile-app

The React Native (Expo) app. Built and tested on Android; iOS is kept possible but
unproven (`design/DECISIONS.md` D12).

What exists is one deliberately basic screen: the device creates its identity on first
launch (kept in the platform's secure storage), shows its id, takes the other person's id
and a server address, and exchanges encrypted messages. It proves the phone can talk to
the backend; the real screens (adding a contact in person, the single thread) are not
built.

```
App.tsx            the screen
src/identity.ts    create / load the identity (secure storage)
src/settings.ts    remembered server address and peer id
```

The encryption and connection code are the shared `tc-crypto` and `tc-client` packages.

## Run it on Android

You need the Android SDK with an emulator, or a phone with USB debugging. The app runs
inside Expo Go, which is installed on the device automatically the first time.

From the repository root, in two terminals:

```
npm run dev:server                 # the backend, on this computer
npm run app -- --android           # builds the app and opens it on the emulator/phone
```

- **Emulator:** the default server address `ws://10.0.2.2:8787` is this computer as seen
  from the emulator. Nothing to change.
- **Real phone:** start the server with `HOST=0.0.0.0 npm run dev:server`, and in the app
  set the server to `ws://<this computer's address on the wifi>:8787`.

To talk to it, use the command-line client (`cli/README.md`):

```
BOB=$(npm run -s cli -- init bob)     # or: id bob, if it already exists
echo $BOB                             # type this into "Their id" in the app, press Connect
APP=<the id shown in the app>
npm run cli -- chat bob --to $APP
```

`ios/` and `android/` folders are not in the repository; nothing here needs them yet.
