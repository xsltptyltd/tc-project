# ws-backend

The websocket backend: an AWS SAM application (`template.yaml`) whose logic lives in
`lambdas/`.

```
lambdas/
  src/core/       the logic — auth, connections, router. No AWS imports.
  src/core/ports.ts   what the logic needs: Store, Transport, clock, id generator
  src/adapters/   implementations of the ports: in-memory, and AWS (DynamoDB store +
                  API Gateway transport; written, never deployed). Any Store must filter
                  expired messages on read (D8). Table layout: DECISIONS D16.
  src/handlers/   Lambda entry points, one per route; thin wrappers around core
  local/          a websocket server running the same core in memory
  test/
```

| Route | Handler | State |
|---|---|---|
| authorizer on `$connect` | `authorizer` | works: verifies the signed connection proof |
| `$connect` / `$disconnect` | `connect` / `disconnect` | written, including the AWS adapters; never run in Lambda |
| `$default` | `router` | `send`, `fetch`, `ack` and `unsend` work |

The sender of a message is told only that it was accepted (`design/DECISIONS.md` D14).

A message is stored, then pushed to every connection its receiver has open. A device that
was offline gets it by sending `fetch` after connecting, which `tc-client` does on its own
(D15). The device then acknowledges it and the backend deletes it (D9); anything never
acknowledged is removed by expiry, 24 hours after it was sent.

Run it locally from the repository root:

```
npm run dev:server        # ws://127.0.0.1:8787, PORT to change
MESSAGE_TTL_SECONDS=1 npm run dev:server   # messages expire after a second (default 24 h)
npm test
```

Expired messages are never delivered and are deleted: by a sweeper every second on the
local server, by the table's TTL on DynamoDB (`design/DECISIONS.md` D8).

The DynamoDB store and the Lambda handlers are tested without AWS, against an in-memory
stand-in for the DynamoDB client (`test/fake-dynamodb.ts`); the store passes the same
tests as the in-memory one (`test/store-contract.test.ts`). That is not AWS: the SAM
template has never been validated, built or deployed, and neither have the AWS adapters
— no claim that they work until they have run there. The DynamoDB table itself
is Terraform, in `infra/dynamodb`, and must exist first. Deployment is by hand:

```
source ~/.aws/tc && sam build && sam deploy --config-file samconfig.dev.toml
```
