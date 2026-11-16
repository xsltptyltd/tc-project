# tc-client

One device's connection to the backend: connect with a signed proof, send an encrypted
message, receive and decrypt. Used by `cli` and `mobile-app`.

Written against the standard `WebSocket` interface (Node 22+, browsers, React Native), so
it has no runtime dependency beyond `tc-crypto` and `tc-protocol`.

`test/e2e.test.ts` runs two clients against the local server from `ws-backend`.
