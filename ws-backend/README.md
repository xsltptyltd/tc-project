# ws-backend

The websocket backend: an AWS SAM application (`template.yaml`) whose logic lives in
`lambdas/`.

```
lambdas/
  src/core/       the logic — auth, connections, router. No AWS imports.
  src/core/ports.ts   what the logic needs: Store, Transport, clock, id generator
  src/adapters/   implementations of the ports: in-memory (done), AWS (not yet)
  src/handlers/   Lambda entry points, one per route; thin wrappers around core
  local/          a websocket server running the same core in memory
  test/
```

| Route | Handler | State |
|---|---|---|
| authorizer on `$connect` | `authorizer` | works: verifies the signed connection proof |
| `$connect` / `$disconnect` | `connect` / `disconnect` | logic works; needs the AWS adapters to run in Lambda |
| `$default` | `router` | `send` works; `ack` answers `not_implemented` |

The sender of a message is told only that it was accepted (`design/DECISIONS.md` D14).

Run it locally from the repository root:

```
npm run dev:server        # ws://127.0.0.1:8787, PORT to change
npm test
```

The SAM template has never been validated, built or deployed. Deployment is by hand:

```
source ~/.aws/tc && sam build && sam deploy --config-file samconfig.dev.toml
```
