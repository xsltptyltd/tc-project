# tc-crypto

Client-side identity and message encryption (`design/DECISIONS.md` D2, D3): generate an
identity, create the connection proof, encrypt for a receiver, decrypt and verify the
sender. The backend never imports this package.

Plain JavaScript (TweetNaCl) so it runs unchanged in Node and React Native.
`src/encoding.ts` holds hand-written base64url and UTF-8 helpers for the same reason:
no `Buffer`, no browser globals.

Call `await init()` once before anything else. On React Native pass a random source:
`init({ randomBytes })`.

`src/invitation.ts` holds the invitation secret, the invitation key (the secret bound to
a proximity value), its token id and the invitee's MAC (D18). The key and the MAC are
libsodium's `crypto_auth` (HMAC-SHA-512-256), written on TweetNaCl's SHA-512; the
libsodium test checks all three.
