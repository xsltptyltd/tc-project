# tap-chat (`tc-project`)

Private, end-to-end encrypted chat for people who have met in person.

This repository is the implementation workspace for tap-chat. It contains shared protocol
and crypto packages, a client SDK, a websocket backend, a CLI, and a React Native app.

## Current status

As of 19 Nov 2026, this project includes three completed implementation milestones:

1. messages for someone away (offline fetch, ack/delete, expiry, unsend, DynamoDB adapter)
2. contacts (invitation flow, contact rules, removal propagation)
3. media (encrypted file transfer, local file store and S3 adapter paths)

The repo is currently positioned as a stable baseline for future feature work.

## Why tap-chat

- Privacy-first messaging: content is encrypted end-to-end before leaving the sender
- In-person trust model: contacts are established through invitation/proximity flows
- Ephemeral behavior: acknowledgement, expiry, and unsend flows are built in
- Developer-friendly architecture: protocol, crypto, client, backend, and app are modular
- Portable local workflow: fully testable without AWS deployment

## How it works

```text
mobile app / CLI -> WebSocket backend -> storage adapters
                     |                    |- in-memory (local)
                     |                    `- DynamoDB adapter path
                     `-> file transfer path (local files, S3-oriented adapter path)
```

- Device identity is key-based (signed connection auth)
- Contacts gate message sending (non-contacts are refused)
- Clients fetch pending messages after reconnect
- Acknowledged messages are deleted from backend storage
- File messages use encrypted metadata and receiver-scoped access flow

## Repository layout

- `tc-protocol/` wire protocol frames, schemas, auth token formats
- `tc-crypto/` identity, encryption, file crypto helpers
- `tc-client/` shared client SDK used by CLI and app
- `ws-backend/` lambda core/adapters/handlers and local dev server
- `cli/` local command-line operations and simulations
- `mobile-app/` Expo React Native app
- `infra/` Terraform/SAM-related infrastructure configuration
- `design/` roadmap and architecture decisions

## Requirements

- Node.js 22 or later
- npm (workspace-aware install from repo root)

## Quick start

From the repository root:

```bash
npm install
npm test
npm run typecheck
```

Run local backend and CLI:

```bash
npm run dev:server
npm run cli -- --help
```

Run simulation:

```bash
npm run simulation
```

Run mobile app (separate app dependencies are under `mobile-app/`):

```bash
npm run app
```

Run multi-terminal walkthroughs and simulation scenarios:

```bash
cat RUN.md
```

## Core capabilities

- End-to-end encrypted one-to-one messaging
- Delivery to offline recipients via websocket `fetch` after reconnect
- Message acknowledgement and deletion behavior
- Message expiry behavior with configurable local TTL testing
- Sender-side unsend for not-yet-delivered messages
- Contact-based send permissions and removal propagation
- Encrypted file transfer with local and S3-oriented adapter paths
- CLI-driven local workflows and simulations

## Engineering approach

- TypeScript across packages with strict type checking
- Vitest test suites in each package
- Local development designed to run without AWS
- Clear seams between protocol, crypto, client, and backend
- Design rationale tracked in `design/DECISIONS.md`
- Roadmap tracked in `design/ROADMAP.md`

See `design/DECISIONS.md`, `design/ROADMAP.md`, and package-level READMEs for details.
