# tc-client

One device's connection to the backend: connect with a signed proof, send an encrypted
message, receive and decrypt. Used by `cli` and `mobile-app`.

On connecting it fetches what arrived while the device was offline. Each message is
handed to the `onMessage` listeners once and then acknowledged, which deletes it from
the backend (`design/DECISIONS.md` D9): after that it exists only in the app's memory.
Register listeners before `connect()`; a message nobody was listening for is not
acknowledged and comes again next time.

`unsend(to, messageId?)` takes back this device's undelivered messages to `to` — one, or
all (D17). The backend does not answer it.

Written against the standard `WebSocket` interface (Node 22+, browsers, React Native), so
it has no runtime dependency beyond `tc-crypto` and `tc-protocol`.

`test/e2e.test.ts` runs two clients against the local server from `ws-backend`.
