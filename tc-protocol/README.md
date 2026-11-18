# tc-protocol

The agreement between a device and the backend: what each may say to the other, and in
what shape. Both sides import this package, so they cannot disagree.

It contains descriptions and checks only. It does not encrypt, store or send anything.

## The conversation today

**1. Connecting.** A device opens a connection and proves who it is. The proof is three
parts joined by dots: its id, the current time, and a signature of the two made with its
secret key. The backend accepts it if the signature is right and the time is within 60
seconds of its own clock.

**2. What a device can say.**

| Frame | Meaning | State |
|---|---|---|
| `send` | "deliver this encrypted text to that device" — only to a contact | works |
| `ack` | "I have message X, delete it" — sent by the client as soon as it has it | works; no answer |
| `fetch` | "send me what is waiting for me" — sent right after connecting | works |
| `unsend` | "take back what I sent to Y that they have not received" — one message, or all | works; no answer |
| `invite` | "hold this invitation for a few seconds" — a token id and my initials | works |
| `accept` | "I accept X's invitation" — token id, X, my initials, a MAC; makes us contacts | works |
| `remove` | "X and I are no longer contacts" — for both, waiting messages deleted | works |
| `contacts` | "who are my contacts?" — used only to drop contacts removed meanwhile | works |

**3. What the backend can say.**

| Event | Meaning |
|---|---|
| `message` | "here is a message for you" (carries an envelope) — pushed live, or in answer to `fetch` |
| `sent` | "your message was accepted" — and nothing more |
| `invited` | "your invitation is held for N seconds" |
| `accepted` | "that invitation was yours; you are contacts now; here are the inviter's initials" |
| `invitee` | to the inviter: "someone accepted your invitation, and is a contact now" — their id, initials, MAC |
| `removed` | "you and X are not contacts" — the answer to `remove`, the same either way |
| `contact_removed` | to both sides' devices: "X is no longer your contact" — drop it, quietly |
| `contacts` | the answer to `contacts`: your contacts' device ids |
| `error` | "that frame was refused", with a short reason |

A sender is never told whether the other person is connected, has received the message
or has read it (`design/DECISIONS.md` D14). Only the receiver of a message can delete it,
and the backend's answer to `ack` is always the same: nothing (D9).

**4. The envelope** is what the backend stores and forwards: a message id, who it is from,
who it is to, the encrypted text, when it was sent and when it expires (24 hours later).
The backend can read all of it except the encrypted text. After it expires the message is
never delivered, even if it is still stored.

**5. Inside the encrypted text** is the payload: a version number and the text.

**6. Contacts.** A message to anyone who is not a contact is refused: `not_a_contact`
(`design/DECISIONS.md` D19). Initials are 1 to 4 letters, A to Z, upper case. An
invitation is known to the backend only by its token id, a hash of a key made from the
code's secret and a proximity value, neither of which the backend ever sees; the key, the
MAC and why are in D18. Whatever the reason an invitation is refused — including a code
accepted from the wrong place — the answer is the same: `invitation_invalid`.
