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
   short-lived value over Bluetooth. **It is never sent to the backend**, nor put in the
   QR: each device mixes it with the QR secret into the invitation's key (D18), and the
   backend knows the invitation only by a hash of that key. B finds the invitation only
   if it read the QR *and* heard the value; a forwarded link, opened anywhere else, gives
   a key that matches no invitation — and does not use the real one up.
4. **B's key returns through the backend, sealed with the invitation key.** B sends its
   public key plus a MAC keyed by the invitation key. The backend only ever sees a hash
   of that key (as the token id), so it cannot swap B's key; A verifies the MAC — which
   also proves B heard the Bluetooth value.
5. **Both confirm** on their own screen, then the backend creates the contact (D5).

Notes:

- The Bluetooth value is a random value the app generates and advertises, rotating with the
  QR and single-use. Hardware addresses are not usable.
- No Bluetooth pairing, no connection, no system dialog beyond the one-time Bluetooth
  permission. A advertises, B passively scans. The user sees: show QR, scan QR, confirm.
- Require a minimum signal strength so "heard" means "close".
- Limit, accepted: this stops uninvited adds completely. Two willing people can still add
  each other remotely with effort; that cannot be made impossible.

Built so far (D18): steps 1 to 4 from a terminal, with a text code instead of the QR
and a room (`TC_ROOM`) instead of Bluetooth. Step 5 is not built: the contact is created
as soon as the invitation is accepted (D19).

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

Built so far (D19, D21): the mirrored records — in memory, or on DynamoDB (D16) — created
in the same step as the invitation is accepted, and breaking a contact as above — both records and the waiting
messages deleted, and both devices' lists updated without a word to the other person. Not
yet the two signatures: A consents by showing the code, B by accepting it, each over its
own authenticated connection. Whether the signatures are still wanted on top of that is
open.

## D6 — No account recovery, for now

A new phone is a new identity; contacts are added again in person.

**Deferred, not rejected:** letting a person type their secret key into the app on a new
phone, which restores the same identity and therefore their contacts. To be decided later.
Known costs: whoever holds the key is that person for good; the old phone keeps working;
labels and aliases do not come back (D13).

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

## D13 — Names: initials, a label per contact, an alias

Three layers, from least to most personal:

1. **Initials.** A new user gives only their initials (1 to 4 letters). This is the only
   name the backend ever holds. Initials are not unique.
   They are the letters A to Z, stored upper case (the app upper-cases what is typed).
   Letters only, so a label such as `PC2` always reads as initials and a number; A–Z
   only, so two labels that look alike are alike (a Cyrillic `А` is not an `A`).
   The device keeps them; the backend is given them only inside an invitation, and keeps
   them only as long as it (D18).
2. **Label.** When A adds B, A's device gives B a label in A's list: B's initials, or the
   initials followed by a number if A's list already has that name (`PC`, then `PC2`,
   `PC3`…), taking the lowest number that is free. The label is fixed when the contact is
   added: it does not change if another contact is removed, if B is met again, or if B
   later changes their initials. Each side has its own label for the other: if A already
   knows a `BB`, B is `BB2` in A's list — and only there.
3. **Alias.** A can give a contact any name on their own device ("Sam", "Tennis
   partner"), and change or remove it at any time. It is shown instead of the label.
   It is stored only on that device and never sent, so it is lost if the device is.

- **Every name in one list is different.** Labels and aliases together: an alias that is
  already another contact's label or alias is refused, and a new contact's label skips
  any name in use, aliases included. Compared ignoring case, so `sam` and `Sam` are the
  same name. An alias is 1 to 32 characters of any kind, without control characters.
- **An alias does not free its label.** The label stays the contact's, visible beside
  the alias (`Sam (BB2)`), and the next `BB` is still `BB3`.
- **A contact is found by any of its names** — alias, label, or device id — which is how
  the CLI's `chat --to` and `alias` take one.
- **Kept on the device, not on the backend.** The label is computed and stored in the
  device's contact book (D20), like the alias. This replaces the earlier plan of storing
  labels on the backend: since devices keep their own contact books, the backend has no
  use for them, and holds one thing fewer. The cost: a restored account (D6) would not
  get its labels back, only its contacts — and only from the backend's side.

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
| contact, one per side | `DEVICE#<owner>` | `CONTACT#<other>` |
| invitation | `INVITATION#<tokenId>` | `INVITATION` |

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
- Key prefixes (`CONNECTION#`, `MSG#`, `CONTACT#`) keep item types apart inside a
  `DEVICE#<id>` partition.
- **A contact is two items, one in each side's partition** (D5): "is X my contact" — on
  every `send` — is one consistent read of an exact key, and "all my contacts" — a sync,
  D21 — one query of a partition the backend already knows. Still no index. The item
  holds who and whom, nothing else: no names (D13), no `ttl` — a contact lasts until
  removed. Both items are written together and deleted together, in one transaction.
- **An invitation is found by its token id**, all an acceptance carries. It holds the
  inviter, their initials, its expiry — also its `ttl`, so the table deletes it (D8) —
  and `acceptedBy` once accepted. Never the invitee's initials: those are only relayed.
- **Accepting is one transaction** — an update of the invitation, conditional on it
  existing, being the inviter's, unexpired and not yet accepted, and the two contact
  items. All or nothing: two devices racing for one invitation cannot both get it, and a
  contact is never half made. A consistent read comes first, for the initials to answer
  with, and refuses most bad attempts without a transaction. A transaction cancelled by
  its condition is a refusal like any other; cancelled for another reason (a conflict
  with another transaction on that item at that instant), it is an error — nothing was
  written, so the invitation is still there to accept.
- **Removing a contact** is one transaction deleting both items; then the messages
  between the two are deleted from each receiver's partition, one query and one delete
  per message (D21).

Implemented in `ws-backend/lambdas/src/adapters/dynamodb-store.ts`; the Lambdas use it for
everything (`adapters/aws.ts`). Tested without AWS: every `Store` and `ContactStore`
behaviour runs against both the in-memory store and this one talking to an in-memory
stand-in for the DynamoDB client (`test/store-contract.test.ts`, `test/invitations.test.ts`,
`test/fake-dynamodb.ts`), and so do whole conversations through the router, the Lambda
handlers, real clients (`tc-client/test/e2e-dynamodb.test.ts`) and the twenty-person
simulation. The stand-in fails where DynamoDB fails — conditions, cancelled transactions
with their reasons, reserved words, paging — and is tested for it. It is not DynamoDB:
nothing has run on AWS yet. `TC_STORE=dynamodb npm run dev:server` runs the local server
on this store and the stand-in, to try it by hand.

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

## D18 — Invitation codes: meeting, and becoming contacts

Adding someone in person (D1) as built so far: two devices side by side exchange their
keys and initials with a short-lived, one-time code, and become contacts (D19). It works
from a terminal today, where a room stands in for Bluetooth; the phone will show the
code as a QR code and use Bluetooth.

1. **A invites.** A's device makes a random 32-byte secret and starts announcing a
   proximity value (below). The invitation key is HMAC-SHA-512-256 (libsodium's
   `crypto_auth`) keyed by the secret, over `tc-invite-key-v1:<proximity value>`. A sends
   the backend only the key's token id — the first 32 bytes of SHA-512 over
   `tc-invite-token-v1:` and the key — with A's initials. The backend keeps the invitation
   for `invitationTtlSeconds` and answers how many seconds that is. A shows the code: A's
   device id and the secret. The proximity value is not in it.
2. **B accepts.** B reads the code, senses the proximity value, derives the same key, and
   sends the token id, A's device id as read from the code, B's initials, and a MAC:
   HMAC-SHA-512-256 keyed by the invitation key, over `tc-invite-v1:<A>:<B>:<B's
   initials>`. B's device id is taken from the connection.
3. **The backend lets it be accepted once.** Only if it exists, has not expired, names A
   as the inviter and has not been accepted yet — checked and recorded as one step, in
   which A and B also become contacts (D19). It then answers B with A's initials, and
   relays B's device id, initials and MAC to every connection A has open.
4. **A checks the MAC** with the key, and believes B only if it matches. The backend
   never saw the key, so it cannot swap B's key or initials.

**Proximity** sits behind one interface, `Proximity` in `tc-client`: the inviter
*announces* a value, the invitee *senses* it. The value is mixed into the key on each side
and never sent anywhere — not to the backend, not in the code.

- **Terminal: a room.** Both people set the same `TC_ROOM`; its value is the proximity
  value (`cli/src/room.ts`). Without `TC_ROOM`, inviting and accepting both fail at once,
  with a message saying so. A stand-in only: anyone who knows the room name counts as
  nearby, and room names are easy to guess — someone holding a code could try a few
  within its 20 seconds. Good enough to develop with; nothing limits how often they try.
- **Phone, for now: a room too.** The app has a room field, `1` by default, so two phones
  — or a phone and a terminal with `TC_ROOM=1` — can add each other without touching it
  (`mobile-app/src/room.ts`). The same stand-in, with the same weakness. The code is
  shown and entered as text; the QR code is not built.
- **Phone, later (not built): Bluetooth.** The inviter advertises a random value, rotating with
  its QR code; the invitee scans for it, ignoring weak signals (D1). Random values
  cannot be guessed, which closes the gap rooms leave.
- **Unavailable means nothing is sent.** If the inviter cannot announce, no invitation is
  registered or shown. If the invitee cannot sense, the acceptance fails before reaching
  the backend, so the invitation is not used up and the invitee can try again (D1).
- **Wrong place means not found.** A code accepted from another room derives another
  token id: the backend finds nothing, answers `invitation_invalid`, and the real
  invitation stays open for the person who is actually there.

Details:

- **Lifetime.** 20 seconds by default (`INVITATION_TTL_SECONDS`); a setting of the backend,
  from 1 to 300 seconds, because the backend is what refuses an expired code. Like
  messages (D8): refused on read from `expiresAt`, and deleted by the sweeper in memory.
  The phone will rotate its QR more often than that (D1: every 10–15 s), so a code scanned
  just before it changes still works.
- **One answer for every refusal.** Unknown (which includes the wrong room), expired,
  already accepted, or naming another inviter: all `invitation_invalid`. Refusals that
  come before the invitation is looked at — B accepting its own invitation, or naming the
  wrong inviter — do not use it up.
- **Nothing about A's presence (D14).** B's answer is the same whether or not A is still
  connected to hear it.
- **What the backend holds:** token id, A's device id and initials, expiry, and once
  accepted, B's device id; and from then on, the contact (D19). Not the secret, not the
  key, not the proximity value. Not B's initials — those are only relayed. The invitation
  goes when it expires.
- **A's initials reach B from the backend**, not from the code, and are not covered by
  the MAC: the backend holds initials anyway (D13). A's key comes from the code only.
- **If the MAC does not match** — only possible if the backend is not honest, or a bug —
  A's device does not add that key to its contact book (D20) and tells A; the invitation
  stays open until it expires. The backend has made the contact on its side regardless,
  which gives it nothing: A's device will neither encrypt to that key nor show what comes
  from it, and ends that contact on the backend at its next sync (D21). Refusing it on
  the backend in the first place is the confirmation step (D5), not built.
- **What is swappable.** On the backend, invitations and contacts sit behind their own
  port, `ContactStore` (`ws-backend/lambdas/src/core/ports.ts`): in memory, or on
  DynamoDB (D16). On the device, two seams in `tc-client`: how the code travels,
  `InvitationCodec` — a line of text between terminals now (`tc1.<device id>.<secret>`);
  on the phone a universal link carrying the same text in its fragment (after `#`, never
  sent to a web server), shown as a QR code — and how proximity is proven, `Proximity`.
  Registering, accepting and checking are the same code for both (`TcClient`).

## D19 — Only contacts can write to each other

The backend refuses a message from a device to anyone who is not its contact. A contact
exists only once an invitation between the two has been accepted, in person (D18).

- **Checked on `send`, before anything is stored.** The answer is `not_a_contact`; the
  message is not stored, and the receiver learns nothing.
- **The refusal tells the sender nothing new.** Contacts are mutual and each side has its
  own list (D5), so the sender already knows. It depends only on the contact, never on
  whether the receiver is connected (D14).
- **Both sides or neither.** A contact is two mirrored records, written in the same step
  as the invitation is accepted; if the two already were contacts, nothing changes.
- **Other frames are unchanged.** `fetch` and `ack` concern only the device's own
  messages; `unsend` only its own undelivered ones.
- **Where it is kept.** With invitations, behind `ContactStore`: in memory locally, in the
  DynamoDB table on AWS (D16). The check on `send` is a consistent read, so a message
  sent a moment after an acceptance is allowed.
- **Not what protects the messages.** This list lets the backend refuse strangers; it is
  the backend's, so an honest backend is needed for it to mean anything. What keeps a
  dishonest one out of the conversation is each device's own list (D20).
- **Removing a contact** (D5, D21) deletes both records and everything waiting between
  the two; from then on each is refused like any stranger.

## D20 — Each device trusts only the keys it exchanged in person

Each device keeps its own contact book: the keys it met in person, with their initials.
It encrypts only to those keys and shows messages only from them. Whatever the backend
says, or someone types, no other key is ever used.

**Why.** The invitation exchange (D18) is built so that the backend cannot slip its own
key in: the inviter's key travels screen to camera, and the invitee's comes back sealed
with a MAC the backend cannot make. That only helps if the checked keys are the ones
used afterwards. A device that would encrypt to any device id it is given — typed by a
person, or handed over by the backend — could be talked into encrypting to the backend,
which would then read every message and pass it on.

- **How a key gets in — only two ways.** The inviter's key, read from its code, when the
  invitee accepts; and the invitee's key, when the inviter's device has checked its MAC.
  Never from the backend alone, and never from a device id typed in.
- **Sending** to a key that is not in the book is refused on the device (`NotAContact`),
  before anything is encrypted. The backend's own refusal (D19) comes second.
- **Receiving:** a message from a key not in the book is not shown and not acknowledged.
  Properly encrypted and signed or not, it is not from anyone this device met. (If it is
  from a contact being added at that very moment, it comes again on the next fetch.)
- **A MAC that does not match** is reported to the person — only a dishonest backend, or
  a bug, can cause one — and the key is not added.
- **Names** come with the key: the initials — the invitee's covered by its MAC, the
  inviter's from the backend (D18), a display name either way — and from them the label,
  given when the contact is added; the alias, later, by the owner (D13).
- **Where the book is kept** sits behind one interface, `ContactBook` (`tc-client`): the
  profile file in the terminal (`.tc/<name>.json`, with the keys — development only), the
  platform's secure storage on the phone (`mobile-app/src/contact-book.ts`), in memory
  in tests. Like
  aliases (D13), it never leaves the device.
- **Removing a contact** takes it out of both devices' books (D21). The backend can make
  a device drop a contact, never add one.
- **Trying it with many people:** `npm run simulation` has twenty profiles meet at random
  through the real exchange, so lists have numbered labels and aliases (`cli/README.md`).

## D21 — Removing a contact reaches both lists

Either person can end a contact, for both (D5). Since each device keeps its own list
(D20), ending it on the backend is not enough: the other device has to drop it too.

1. **The one removing asks the backend** (`remove`), and waits for its answer. The backend
   deletes both contact records, then every message still waiting between the two, in
   either direction, delivered or not. The answer, `removed`, is the same whether or not
   they were contacts. Then that device drops the contact from its list.
2. **Devices connected now are told at once:** `contact_removed` goes to every connection
   of both people — the other person's devices, and the remover's other devices.
3. **Devices that were offline catch up when they connect:** a device asks the backend
   for its contacts (`contacts`) and drops any the backend no longer has. The CLI does it
   after every connection, `cli contacts` included; the app will when opened.
4. **The same sync ends half a contact.** A contact the backend has and the device does
   not — the inviter's connection dropped before it was told of the acceptance, or its
   MAC did not match (D18) — is one the device never checked. It asks the backend to
   remove it, which also deletes what was waiting and drops it from the other device's
   list. So the two lists and the backend end up agreeing: both, or neither. Not while
   an invitation of this device is open or being accepted, when the backend may simply
   know first. The confirmation step of D5 would prevent the half contact instead of
   repairing it; it is still not built.

- **Nothing is kept for the other side.** No notice waits on the backend for an offline
  device: it learns from the backend's list, which simply no longer has the contact
  (D5: nothing about the former contact is kept).
- **The other person is not told.** Their device drops the contact quietly — no message,
  no notification; the CLI's chat prints nothing. It is noticed only by its absence, or
  when writing is refused.
- **Only removals follow the backend; additions never do.** A `contact_removed`, or a
  list, can make a device drop a contact; nothing the backend says can make it add one
  (D20). So a dishonest backend can end contacts — it could refuse to deliver anyway —
  but still cannot put its own key into a list.
- **One answer cannot empty a list.** If the backend's list has none of the device's
  contacts, and the device has more than one, the device drops nothing and says so
  (`syncContacts()` resolves `refused`; the CLI prints a warning). The keys in a list can
  only be had again by meeting, so a backend that has lost its data — a restart, a new or
  wrong table, a bug — must not be able to delete them all at once. The cost: someone
  whose every contact removed them while they were offline keeps those names until they
  try to write, and is refused. A single contact, or some among several, is still
  dropped as above.
- **Removing someone who is not a contact does nothing.** The answer is the same
  `removed`, but nothing is deleted and nobody is told: a device cannot make the backend
  write to one it never met.
- **A contact being added while a list is on its way is kept.** The backend's list may
  have been read just before an invitation was accepted; the device does not drop a
  contact it added after asking.
- **Meeting again starts afresh.** A new invitation, a label computed anew (often the
  same one), no alias: nothing of the old contact was kept (D13).
- **Edge left open:** a message being sent at the very moment of removal — checked as
  between contacts just before, stored just after the waiting messages were deleted — is
  stored. Its receiver's device does not show it (D20) and does not acknowledge it, so it
  expires after 24 hours.
- **The dev server keeps contacts in memory** (even with `TC_STORE=dynamodb`, whose
  stand-in table is in memory too). Restart it, and the backend no longer has them: a
  device with one contact drops it the next time it connects, one with several keeps its
  list (above) but is refused when it writes, until the two meet again. On AWS the table
  keeps them.
