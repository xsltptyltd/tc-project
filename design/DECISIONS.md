# Decisions

What has been decided and why. One entry per decision; if a decision changes, rewrite the
entry rather than adding a competing one.

## D1 — Adding a contact: QR code + Bluetooth proximity

Two people add each other only when their phones are side by side.

1. **A shows a QR** in the app. It encodes a link carrying A's public key and a one-time
   secret, both in the URL fragment (after `#`) so they never reach a web server. It rotates
   every 10–15 s and the first use consumes it.
   **If Bluetooth is off or not permitted on A, no QR is shown** — A gets a message and a
   shortcut to settings instead.
2. **B scans it**, with the phone camera or the in-app scanner; the link opens the app.
   A's key has now travelled screen → camera, outside the backend.
   **If Bluetooth is off or not permitted on B, the add fails there**, before anything is
   sent to the backend, so the code is not consumed and B can retry.
   The link can be copied or forwarded; a forwarded link fails the proximity check in step 3.
3. **Bluetooth proves proximity.** While the QR is on screen, A broadcasts a random
   short-lived value over Bluetooth and registers it with the backend. The backend never
   hands it out: B must report the value it heard, and the backend checks it matches.
4. **B's key returns through the backend, sealed with the QR secret.** B sends its public key
   plus a MAC keyed by the QR secret. The backend only ever sees a hash of that secret (as
   the token id), so it cannot swap B's key; A verifies the MAC.
5. **Both confirm** on their own screen, then the backend creates the contact (D5).

Notes:

- The Bluetooth value is a random value the app generates and advertises, rotating with the
  QR and single-use. Hardware addresses are not usable.
- No Bluetooth pairing, no connection, no system dialog beyond the one-time Bluetooth
  permission. A advertises, B passively scans. The user sees: show QR, scan QR, confirm.
- Require a minimum signal strength so "heard" means "close".
- Limit, accepted: this stops uninvited adds completely. Two willing people can still add
  each other remotely with effort; that cannot be made impossible.

## D2 — Encryption: NaCl formats, pure JavaScript

- Text messages use NaCl `crypto_box` (X25519 + XSalsa20-Poly1305), the same format as
  libsodium. It is authenticated: a message only decrypts if it was encrypted by the sender
  it claims to be from.
- Ciphertext on the wire is base64url(nonce ‖ box).
- The implementation is TweetNaCl, plain JavaScript with no native module, so the same code
  runs in Node, on Android and on iOS. A test checks its output against libsodium, so a
  libsodium-based client stays compatible.
- Media (later) will use a random key per file, the key travelling inside a normal message.

Implemented in `tc-crypto`.

## D3 — Identity is a key pair

- On first launch the app generates an Ed25519 key pair. The **device id is the public
  key** (32 bytes, base64url).
- The encryption keys are derived from the same pair, so the device id is the only thing
  two people exchange.
- The backend authenticates a device by an Ed25519 signature over
  `tc-auth-v1:<deviceId>:<timestamp>`, accepted within 60 seconds. Knowing a device id
  proves nothing — every contact knows it.
- Public keys are exchanged in person (D1), never fetched from the backend.

Implemented in `tc-protocol`, `tc-crypto` and `ws-backend/lambdas/src/core/auth.ts`.

## D4 — Key storage on the phone

The secret key is stored in the iOS Keychain / Android Keystore, device-only and excluded
from backups.

## D5 — A contact needs both signatures

After D1 each device holds the other's public key. Each signs (own key, other key, QR token
id), and the backend creates the contact only when it holds both signatures for the same
unconsumed token. Either person can remove the contact, which removes it for both.

The backend therefore knows who is in contact with whom, and their initials (D13). Content stays
private; this metadata does not.

**One relationship, two records.** A contact is mutual by definition, but it is stored as
two mirrored records — "A's contact B" and "B's contact A" — each holding that side's label
(D13). The two are always written and deleted together in one all-or-nothing operation, so
they cannot disagree.

**Breaking a contact** — either person can, at any time:

- both records are deleted;
- messages still waiting between the two, in either direction, are deleted;
- the other person is not told: the contact simply disappears from their list;
- nothing about the former contact is kept.

**Adding someone who is already a contact** changes nothing: no second contact, no new
label.

## D6 — No account recovery, for now

A new phone is a new identity; contacts are added again in person.

**Deferred, not rejected:** letting a person type their secret key into the app on a new
phone, which restores the same identity and therefore their contacts. To be decided later.
Known costs: whoever holds the key is that person for good; the old phone keeps working;
nicknames do not come back (D13).

## D7 — The missed-messages REST API uses the same authorizer

The integration is API Gateway → DynamoDB with no Lambda, but the request is authenticated
by the same authorizer as the websocket. The query's partition key comes from the
authorizer, never from the request.

## D8 — Expiry is enforced on read

DynamoDB's automatic deletion can lag by hours or days. Every read filters
`expiresAt > now`. Same principle for media on S3.

## D9 — Messages are deleted on acknowledgement

A message stays on the backend until the receiver acknowledges it, or 24 hours. The phone
keeps decrypted text in memory only and re-fetches the ciphertext after a lock or restart.
The acknowledgement is between the receiver and the backend; the sender is not told (D14).

## D10 — Push notifications carry no content

The backend cannot decrypt, so a push says only that there is a new message.

## D11 — Screen protection

Android blocks screenshots (`FLAG_SECURE`). iOS cannot block them: the app covers its
content in the app switcher and when in the background, and detects screen capture.
The app locks after 2 minutes of inactivity.

## D12 — Android first, iOS kept possible

The app is built and tested on Android. iOS is not built or tested for now, but nothing may
rule it out, so that supporting it later is a small step:

- React Native with Expo; the `ios/` and `android/` folders are generated, never edited by
  hand.
- No native module for encryption (D2).
- Only libraries that support both platforms.
- Platform-specific behaviour (Bluetooth permissions, screenshot blocking, key storage)
  sits behind one small module each, with the iOS side left as a clearly marked gap.
- No claim that iOS works until it has been run on a device.

## D13 — Names: initials, a label per contact, a local nickname

Three layers, from least to most personal:

1. **Initials.** A new user gives only their initials (1 to 4 letters). This is the only
   name the backend ever holds. Initials are not unique.
2. **Label.** When A adds B, the backend stores on that contact the label A will see: B's
   initials, or the initials followed by a number if A already has a contact with that
   label (`PC`, then `PC2`, `PC3`…), taking the lowest number that is free. The label
   is fixed when the contact is created: it does not change if another contact is removed
   or if B later changes their initials. Each side has its own label for the other.
   Since nothing is kept after a contact is broken (D5), adding the same person again
   computes the label afresh — which gives the same label back unless it was taken
   meanwhile.
3. **Nickname.** A can replace the label with any name on their own phone ("Pierre"), and
   change it again at any time. It
   is stored only on that phone and never sent, so it is lost if the phone is.

Because the label lives on the backend, a restored account (D6) gets its contacts back as
`PC`, `PC2`…, without the nicknames.

## D14 — No presence, no receipts (for now)

A person never learns whether someone else is connected, has received a message, or has
read it.

- When a message is sent, the backend answers only "accepted". The answer is identical,
  and is given before any delivery attempt, whether or not the receiver is online.
- Acknowledging a message deletes it; the sender is not notified.
- Nothing shows who is online, when someone was last seen, or that someone is typing.

This is about what other people can learn. The backend itself necessarily knows which
devices are connected, in order to deliver messages; it does not pass that on.

"For now": this can be revisited, but anything that reveals another person's activity
needs its own decision here first.
