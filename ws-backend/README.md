# ws-backend

The websocket backend: an AWS SAM application (`template.yaml`) whose logic lives in
`lambdas/`.

```
lambdas/
  src/core/       the logic — auth, connections, router. No AWS imports.
  src/core/ports.ts   what the logic needs: Store, ContactStore, Transport, clock, id generator
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
| `$default` | `router` | `send` (only between contacts), `fetch`, `ack`, `unsend`, `invite`, `accept`, `remove` and `contacts` work |

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

Only contacts can write to each other (`design/DECISIONS.md` D19): a `send` to anyone
else is answered `not_a_contact` and nothing is stored. Either side can `remove` a
contact, for both: the backend deletes it and everything waiting between them, and tells
both sides' connected devices; others catch up by asking for their `contacts` (D21). Accepting an invitation is what
makes two devices contacts (D18). Invitations are held for 20 seconds, accepted once,
then swept; `INVITATION_TTL_SECONDS=60 npm run dev:server` changes that (1 to 300). The
backend never sees the proximity value (the CLI's room) an invitation is bound to.

Both stores keep everything — messages, connections, invitations and contacts — and pass
the same tests. On DynamoDB it is all one table (`design/DECISIONS.md` D16): a contact is
an item in each side's `DEVICE#` partition, an invitation is found by its token id, and
accepting one is a single transaction. To run the local server on the DynamoDB store
(with the in-memory stand-in for the DynamoDB client, not AWS):

```
TC_STORE=dynamodb npm run dev:server
```

Expired messages are never delivered and are deleted: by a sweeper every second on the
local server, by the table's TTL on DynamoDB (`design/DECISIONS.md` D8).

The DynamoDB store and the Lambda handlers are tested without AWS, against an in-memory
stand-in for the DynamoDB client (`test/fake-dynamodb.ts`), which fails where DynamoDB
would: failed conditions, cancelled transactions with their reasons, reserved words,
paging. The store passes the same tests as the in-memory one (`test/store-contract.test.ts`,
`test/invitations.test.ts`), and whole conversations run on it through the handlers, real
clients and the simulation. That is not AWS: the SAM
template has never been validated, built or deployed, and neither have the AWS adapters
— no claim that they work until they have run there. The DynamoDB table itself
is Terraform, in `infra/dynamodb`, and must exist first. Deployment is by hand:

```
source ~/.aws/tc && sam build && sam deploy --config-file samconfig.dev.toml
```
