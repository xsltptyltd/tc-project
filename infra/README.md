# infra

Terraform for tc. One stack per directory, state in S3 (`tc-tfstates-us-west-2`, one key per
stack). The websocket API is **not** here — it is SAM, in `ws-backend/`.

| Directory | What | State |
|---|---|---|
| `dynamodb/` | `tc-{stage}-{version}` single table (layout: `design/DECISIONS.md` D16) | written, never applied |
| `api-gateway/` | optional REST API, VTL → DynamoDB, for missed messages (`design/DECISIONS.md` D7) | placeholder |
| `s3/` | encrypted media bucket | placeholder |

Terraform is applied by hand by the maintainer.
