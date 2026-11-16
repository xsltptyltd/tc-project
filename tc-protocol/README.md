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
| `send` | "deliver this encrypted text to that device" | works |
| `ack` | "I have read message X, delete it" | defined, the backend answers "not implemented" |

**3. What the backend can say.**

| Event | Meaning |
|---|---|
| `message` | "here is a message for you" (carries an envelope) |
| `sent` | "your message was accepted" — and nothing more |
| `error` | "that frame was refused", with a short reason |

A sender is never told whether the other person is connected, has received the message
or has read it (`design/DECISIONS.md` D14).

**4. The envelope** is what the backend stores and forwards: a message id, who it is from,
who it is to, the encrypted text, when it was sent and when it expires (24 hours later).
The backend can read all of it except the encrypted text.

**5. Inside the encrypted text** is the payload: a version number and the text.
