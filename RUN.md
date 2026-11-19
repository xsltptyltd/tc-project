# RUN.md

Practical command guide for running tap-chat locally across multiple terminals and trying
the main supported flows.

All commands are run from the repository root: `tc-project/`.

## 1) One-time setup

```bash
npm install
```

Optional checks:

```bash
npm test
npm run typecheck
```

## 2) Terminal layout

Use at least 3 terminals.

- Terminal A: backend server
- Terminal B: one user profile (example: `alice`)
- Terminal C: second user profile (example: `bob`)

For some scenarios, open Terminal D for a third profile (example: `carol`).

## 3) Start backend

Terminal A:

```bash
npm run dev:server
```

Useful variants:

```bash
# very short message expiry for testing
MESSAGE_TTL_SECONDS=1 npm run dev:server

# longer invitation lifetime (default is 20 seconds)
INVITATION_TTL_SECONDS=120 npm run dev:server

# run local server with DynamoDB adapter code path (in-memory fake DynamoDB client)
TC_STORE=dynamodb npm run dev:server
```

## 4) Create identities and initials

Terminal B:

```bash
npm run cli -- init alice
npm run cli -- initials alice AZ
```

Terminal C:

```bash
npm run cli -- init bob
npm run cli -- initials bob BB
```

You can check identity data anytime:

```bash
npm run cli -- id alice
npm run cli -- initials alice
npm run cli -- contacts alice
```

## 5) Add contacts (invite + accept)

Both people must use the same `TC_ROOM` value.

Terminal B (alice invites):

```bash
TC_ROOM=1 npm run cli -- invite alice
```

Copy the printed `tc1....` code.

Terminal C (bob accepts):

```bash
TC_ROOM=1 npm run cli -- accept bob 'tc1....'
```

Verify both sides:

```bash
npm run cli -- contacts alice
npm run cli -- contacts bob
```

### Negative test: wrong room should fail

```bash
TC_ROOM=2 npm run cli -- accept bob 'tc1....'
```

## 6) Chat in two terminals

Open/keep two chat sessions.

Terminal B:

```bash
npm run cli -- chat alice --to BB
```

Terminal C:

```bash
npm run cli -- chat bob --to AZ
```

Type messages and press Enter.

Inside chat:

- `> delete` unsends messages not yet received
- `Ctrl-D` exits chat

## 7) Offline delivery flow (fetch on reconnect)

1. Start chat on alice side.
2. Keep bob offline (no running chat/client).
3. Send one or more messages from alice.
4. Start bob chat:

```bash
npm run cli -- chat bob --to AZ
```

Bob should receive pending messages after connect/fetch.

## 8) Aliases and contact naming

Set alias:

```bash
npm run cli -- alias alice BB "Tennis Bob"
```

Remove alias:

```bash
npm run cli -- unalias alice "Tennis Bob"
```

List:

```bash
npm run cli -- contacts alice
```

## 9) Remove a contact

Either side can remove. Example from alice:

```bash
npm run cli -- remove alice BB
```

Then validate:

```bash
npm run cli -- contacts alice
npm run cli -- contacts bob
```

Sending after removal should be refused until they add each other again.

## 10) Common third-user scenario

Create a third identity (Terminal D):

```bash
npm run cli -- init carol
npm run cli -- initials carol CD
```

Then repeat invite/accept between:

- alice ↔ carol
- bob ↔ carol

And inspect all lists:

```bash
npm run cli -- contacts alice
npm run cli -- contacts bob
npm run cli -- contacts carol
```

## 11) Simulations

Run with server already up (Terminal A).

Terminal B (or any free terminal):

```bash
npm run simulation
```

Useful options:

```bash
# deterministic run
npm run simulation -- --seed 42

# allow replacing existing named profiles created outside simulation
npm run simulation -- --replace

# combine both
npm run simulation -- --seed 42 --replace
```

After simulation, inspect generated profiles:

```bash
npm run cli -- contacts alice
npm run cli -- contacts grace
npm run cli -- contacts john
```

## 12) Run mobile app with local backend (optional)

In another terminal:

```bash
npm run app
```

For details and emulator/device networking specifics, see `mobile-app/README.md`.

## 13) Useful reset/cleanup commands

Remove local profile data:

```bash
rm -rf .tc
```

Recreate from scratch:

```bash
npm run cli -- init alice
npm run cli -- initials alice AZ
```

---

If you only need a minimal smoke test, use this order:

1. `npm run dev:server`
2. init+initials for `alice` and `bob`
3. `TC_ROOM=1 npm run cli -- invite alice`
4. `TC_ROOM=1 npm run cli -- accept bob 'tc1....'`
5. open two chats and exchange messages
