# tap-chat (tc)

Private one-to-one messaging for people who have met in person.

- **You can only add someone face to face.** One phone shows a short-lived QR code, the other
  scans it, and Bluetooth confirms the two phones are side by side.
- **Either person can end it.** Removing a contact removes you from the other phone too.
- **The server cannot read messages.** They are encrypted on the sending phone and only the
  receiving phone can open them.
- **Nothing is kept.** A message is deleted from the server when it is acknowledged, and
  after 24 hours at the latest.
- **No account.** No email, no phone number, no name — only your initials.

Open source under the MIT licence. Status: **early** — a first slice runs locally (two clients exchanging encrypted messages
through the backend logic, from a terminal or from a basic Android app); nothing is
deployed. See `design/ROADMAP.md`.

## How it works

```
 mobile-app ──wss──► API Gateway WebSocket ──► ws-backend λ ──► DynamoDB tc-{stage}-{v}
     │                    (authorizer λ)            │                 ▲
     │                                              └─► push (APNs/FCM) when offline
     └──https──► API Gateway REST ──VTL──────────────────────────────┘   (missed messages)
     └──https──► S3 (encrypted media, later)
```

- **Identity.** On first launch the app generates a key pair. The public key is the device's
  identity; the server authenticates a device by a signature, never by an id alone.
- **Adding a contact.** See `design/DECISIONS.md` D1 and D5.
- **One thread.** There are no per-contact conversations. Each message shows who sent it;
  tap a bubble to reply to that person. Sent messages show for one minute; received messages
  disappear once acknowledged (by replying or ticking).
- **Names.** A contact appears under their initials (`PC`, or `PC2` if you already have a
  `PC`). You can give them a nickname on your phone; the server never sees it.
- **What the server does know:** your initials, which devices are contacts, and when messages
  pass. Content is private; this metadata is not.

## Layout

| Folder | What |
|---|---|
| `tc-protocol/` | the wire contract: frames, envelope, auth token, validation |
| `tc-crypto/` | client-side identity and encryption |
| `ws-backend/` | the websocket backend: AWS SAM template + `lambdas/` (logic, handlers, local server) |
| `tc-client/` | one device's connection to the backend (connect, send, receive), shared by the CLI and the app |
| `cli/` | command-line client for local development |
| `infra/` | Terraform, one stack per directory: `dynamodb/`, `api-gateway/` (REST, missed messages), `s3/` (media) |
| `mobile-app/` | the React Native (Expo) app — Android first, iOS later (`DECISIONS.md` D12). One basic screen so far |
| `design/` | `ROADMAP.md` (where this is going), `DECISIONS.md` (what was decided and why), `README-environments.md` |

Each folder has a `README.md`.

## Running it

Node 22 or later. From the repository root:

```
npm install
npm test             # all tests, no AWS needed
npm run typecheck    # the phone app has its own: npm --prefix mobile-app run typecheck
npm run dev:server   # local websocket server
npm run cli -- ...   # command-line client, see cli/README.md
npm run app          # the phone app; needs its own install first, see mobile-app/README.md
```

## Conventions

- TypeScript, strict. Node 22+. One npm workspace for everything except `mobile-app`, which has its own install; packages are consumed as source, no build step.
- Tests are vitest, in each package's `test/` folder.
- Everything that can be tested without AWS is tested without AWS: handlers take their
  storage and transport as dependencies so tests run against in-memory versions.
- Infrastructure (Terraform, SAM) is deployed by hand by the maintainer; there is no CI.
- No secrets, account ids or personal data in the repository.
- Design changes are recorded in `design/DECISIONS.md`; where the project is going is in
  `design/ROADMAP.md`.

## Later

Encrypted media (uploaded straight to S3, never through the websocket) and groups (one
encrypted copy per member).
