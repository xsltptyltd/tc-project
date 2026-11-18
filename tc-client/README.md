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

**This device trusts only keys it exchanged in person** (`design/DECISIONS.md` D20). They
are kept in a `ContactBook` given to the constructor (`src/contacts.ts`): `send` to any
other key rejects with `NotAContact` before anything is encrypted, and messages from any
other key are never shown. Keys get in only through `accept` (the inviter's, read from
the code) and `invite` (the invitee's, once its MAC is checked). So a backend that hands
over its own key instead gets nowhere: the MAC fails, `onForgedInvitee` is called, and
that key is never used. The backend also refuses non-contacts (`ServerError
('not_a_contact')`, D19) — but this does not depend on it being honest.

`ContactBook` is where the app keeps that list: the CLI's profile file, the phone's secure
storage (not built), `MemoryContactBook` in tests and by default. It only stores; the
rules are in `ContactList`, shared by every app (D13): each contact gets a label when met
— its initials, numbered if the list already has them (`BB2`) — and may get an alias,
shown instead. No two contacts in a list have the same name; `find` takes any of them.
Incoming messages carry that name: `IncomingMessage.name`.

`removeContact(id)` ends a contact for both sides (D21). The other device drops it when
told — at once if connected, otherwise at `syncContacts()`, which apps call after
connecting. `onContactRemoved` reports drops, for refreshing a screen, not for telling the
person. The backend can make this device drop a contact; it can never make it add one.
`syncContacts()` also ends, on the backend, a contact this device never checked, so
nobody is left with half a contact; and it resolves `refused`, dropping nothing, if the
backend knows none of several contacts — one answer cannot empty a list (D21).

A request rejects with `no answer from the server` after `REQUEST_TIMEOUT_MS` (15 s).
Answers are matched to requests by kind, not by the order sent.

Invitations make contacts (D18): `invite(initials, proximity)` registers a new one and
returns what to show; `onInvitee` reports, once, whoever accepted it — after checking their
MAC with the invitation key, so the backend cannot swap them. `accept(invitation,
initials, proximity)` is the other side. The key stays in this object's memory, only until
the invitation is accepted, closed or expires.

Two seams, so the terminal and the phone share everything else:

- **`InvitationCodec`** (`src/invitation.ts`) — how the code gets from one screen to the
  other. `textInvitationCodec` is the terminal's: `tc1.<device id>.<secret>`. The phone
  will add one that wraps the same text in a universal link for a QR code.
- **`Proximity`** (`src/proximity.ts`) — how two devices prove they are side by side. The
  inviter `announce`s a value, the invitee `sense`s it; it is mixed into the invitation
  key and never sent. The CLI's is a room (`TC_ROOM`, `cli/src/room.ts`); the phone's
  will be Bluetooth. Either throws `ProximityUnavailable` when it cannot work, and then
  nothing is sent.

Written against the standard `WebSocket` interface (Node 22+, browsers, React Native), so
it has no runtime dependency beyond `tc-crypto` and `tc-protocol`.

`test/e2e.test.ts` runs two clients against the local server from `ws-backend`.
