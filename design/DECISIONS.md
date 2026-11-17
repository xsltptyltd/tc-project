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

## D8 — After 24 hours a message is never delivered, and it is deleted

A message nobody acknowledged lives 24 hours (`MESSAGE_TTL_SECONDS`). Two mechanisms,
because they guarantee different things:

- **Never delivered after expiry — exact, on read.** Every read skips anything with
  `expiresAt <= now`, whatever the storage has or has not cleaned up yet.
- **Deleted after expiry — in the background.** On DynamoDB, every message carries
  `ttl = expiresAt` and the table's TTL deletes it; AWS does this "typically within a few
  days", not to the second, which is why the read check above is needed. In memory, a
  sweeper (`setInterval`, every second on the local server) deletes expired messages
  whoever they are for, and a read sweeps first.

The lifetime is a setting of the backend (`Deps.messageTtlSeconds`): 24 hours when
deployed, as short as one second in tests and local runs (`MESSAGE_TTL_SECONDS=1 npm run
dev:server`) to watch it happen — never longer than 24 hours. Times are whole seconds, so
a lifetime of N seconds ends between N−1 and N seconds after sending.

If deletion within days is ever not enough on DynamoDB, the next step is a scheduled
sweep; it needs an index by expiry time, which the unused GSI1 can carry (D16). Not built.

Same principle for media on S3.

## D9 — Messages are deleted on acknowledgement, as soon as they are received

A message stays on the backend until the receiver acknowledges it, or 24 hours.

- **The client acknowledges a message as soon as it has handed it to the app** — not when
  a person dismisses it. From then on the message exists only in that app's memory:
  close, clear or restart the app and it is gone, from everywhere. Like something said
  aloud, it cannot be heard twice.
- Only the receiver can delete a message: the backend takes the device from the
  authenticated connection, never from the frame, and an acknowledgement naming someone
  else's message does nothing.
- The backend answers an acknowledgement with nothing — not even whether the message
  existed — and the sender is not told (D14). Repeating one is harmless.
- Delivery is at least once: a message the client never acknowledged (connection lost
  first, nobody listening yet, or undecryptable) is delivered again on the next `fetch`,
  until it expires. One that could not be decrypted is never acknowledged; it expires.
- A client that is sent a message it has already shown does not show it again, and
  acknowledges it again: the first acknowledgement was lost.

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
3. **Nickname.** A can replace the label with any name on their own phone ("Sam"), and
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
- Taking back a message (D17) gets no answer, so it cannot tell the sender whether the
  message had been delivered.
- Nothing shows who is online, when someone was last seen, or that someone is typing.

This is about what other people can learn. The backend itself necessarily knows which
devices are connected, in order to deliver messages; it does not pass that on.

"For now": this can be revisited, but anything that reveals another person's activity
needs its own decision here first.

## D15 — Waiting messages are fetched over the websocket, right after connecting

A message for a device that is offline stays stored (D8, D9). When the device connects it
sends a `fetch` frame, and the backend answers on that connection with one `message` event
per unexpired message addressed to it, oldest first.

- **Why a frame and not a push on connect:** API Gateway does not let the backend post to
  a connection while `$connect` is running, so anything sent from `$connect` would be lost.
  A frame goes through `$default` and behaves the same locally and on AWS.
- A message sent while the receiver is connecting can reach it twice (live, and in the
  answer to `fetch`). Message ids are unique; the client shows each id once.
- A delivered message is deleted when the device acknowledges it (D9). One it has not
  acknowledged comes again on the next `fetch`.
- Nothing about this is visible to the sender (D14).
- The REST API for missed messages (D7) is not needed for this. Whether it is still wanted,
  for example to read messages without opening a websocket, is open.

## D16 — One DynamoDB table, keyed by who needs to find what

Everything lives in the single table from `infra/dynamodb` (PK, SK, one generic GSI, TTL
on `ttl`). The layout follows the access patterns, not the other way round:

| Item | PK | SK |
|---|---|---|
| connection, by id | `CONNECTION#<connectionId>` | `CONNECTION` |
| connection, by device | `DEVICE#<deviceId>` | `CONNECTION#<connectionId>` |
| message | `DEVICE#<to>` | `MSG#<id>` |

A message item also holds the envelope's fields, `ttl`, and `delivered: true` once it has
been handed to its receiver (D17).

- **Every read is on the base table, strongly consistent. No index is used.** A GSI can
  only be read with eventual consistency, and two reads cannot live with that (below).
- **A connection is stored twice, written and removed in one transaction.** By connection
  id, because that is all a `$disconnect` event carries and the first frame can arrive
  right after `$connect`. By device, to deliver live.
- **Why "by device" must be consistent.** A message is stored, then the receiver's
  connections are read. A device writes its connection, then fetches. With consistent
  reads one of the two always happens: the sender sees the connection and the message is
  pushed, or the connection came later and its fetch sees the message. With an index, a
  message sent a moment after the receiver's fetch could be missed by both, and wait
  until the receiver's next connection.
- **Messages sit in the receiver's partition.** A `fetch` sent right after connecting sees
  a message written a moment earlier. The REST read (D7), acknowledgement (D9) and
  contact-break deletions (D5) all start from a receiver the backend already knows.
- **The sort key is the message id, not the time.** An acknowledgement carries only the
  id, and the receiver comes from the connection: together they are the exact key, so
  acknowledging is one delete with no read first. Oldest-first order is restored by
  sorting on `sentAt` after reading, which costs nothing because `fetch` reads the
  receiver's messages anyway; the REST read (D7) will have to do the same.
- **GSI1 stays declared and unused.** An index is used when an access pattern cannot be
  answered from a partition the backend already knows — not before.
- The `ttl` attribute is `expiresAt` on messages (best effort; reads still filter, D8)
  and connect time + 3 hours on connections, which only matters if a `$disconnect` was
  lost: API Gateway closes every websocket within 2 hours anyway.
- Key prefixes (`CONNECTION#`, `MSG#`) keep item types apart inside a `DEVICE#<id>`
  partition, and leave room for later ones, contacts first of all.

Implemented in `ws-backend/lambdas/src/adapters/dynamodb-store.ts`. Tested without AWS:
every `Store` behaviour runs against both the in-memory store and this one talking to an
in-memory stand-in for the DynamoDB client (`test/store-contract.test.ts`,
`test/fake-dynamodb.ts`). The stand-in is not DynamoDB: nothing has run on AWS yet.

## D17 — A sender can take back a message until it is delivered

A sender may delete what they sent and the receiver has not received yet: one message
(`unsend` with its id — what an app would offer on a message) or everything they sent to
one person (`unsend` without an id — the CLI's `> delete`). Only their own messages: the
sender is taken from the authenticated connection, never from the frame.

- **Delivered means handed over, not acknowledged.** The receiver can have a message on
  screen before it acknowledges it, so the backend marks a message delivered the moment
  it starts handing it to one of the receiver's connections — live, or in answer to
  `fetch` — and a delivered message can no longer be taken back. It is marked *before*
  it is posted: if the connection turns out to be gone, that message cannot be taken back
  either, which is the safe side to err on.
- **Whichever comes first wins.** Marking succeeds only if the message still exists, and
  taking back succeeds only if it is not marked; on DynamoDB both are conditional writes.
  So a message taken back is never delivered afterwards, even by a `fetch` already under
  way, and a delivered one is never deleted by its sender.
- **No answer, ever (D14).** Saying what was deleted would say what was delivered. The
  backend answers `unsend` with nothing, so the CLI can only say "whatever they had not
  received yet is gone", never how many.
- The mark is backend bookkeeping: it is not part of the envelope, and it is deleted with
  the message.
- On DynamoDB this stays in the receiver's partition (the frame names the receiver): one
  conditional delete for one message; for all, a consistent query of that partition for
  the sender's undelivered messages, then one conditional delete each. No new index.

