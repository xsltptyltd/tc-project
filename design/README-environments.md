# Environments

- **dev** — deployed backend, app on a simulator/device pointing at it. Tables are disposable.
- **staging** — TestFlight / internal track builds.
- **prod** — store builds.

Conventions (to be created, nothing exists yet):

- AWS credentials: `source ~/.aws/tc && …`
- Region: `us-west-2` (placeholder — confirm)
- Terraform state bucket: `tc-tfstates-us-west-2`, one key per stack
- SAM artefact bucket: `tc-sam-us-west-2`
- DynamoDB table: `tc-{stage}-{version}`, passed as `DYNAMODB_TABLE`
- No CI. Every stack is deployed from a developer machine, by the developer.
