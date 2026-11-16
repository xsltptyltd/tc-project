# cli

A command-line client for local development: it does what the phone app will do, without
the phone. The connection logic is in `tc-client`; `src/main.ts` is the command line.

Run everything from the repository root.

Terminal 1 — the server:

```
npm run dev:server
```

Terminal 2 — create two identities once, keeping their ids in variables
(`-s` stops npm printing its own lines, so only the id is captured):

```
ALICE=$(npm run -s cli -- init alice)
BOB=$(npm run -s cli -- init bob)
npm run cli -- chat bob --to $ALICE
```

Terminal 3 — variables are per terminal, so read the ids back with `id`:

```
ALICE=$(npm run -s cli -- id alice)
BOB=$(npm run -s cli -- id bob)
npm run cli -- chat alice --to $BOB
```

Type a line in either chat and press enter; ctrl-d quits.

Identities are stored unencrypted in `./.tc/` (git-ignored). Development only.
`TC_URL` selects another server (default `ws://127.0.0.1:8787`).
