# Roadmap

In rough order. Each line is a goal, not a specification.

## Done

- Key-pair identity, signed connection
- Encrypted one-to-one messages
- Local server, command-line client, basic Android app
- Delayed messages when not online, in memory (D15)
- 24-hour expiry: never delivered after, then deleted — memory sweeper, DynamoDB TTL (D8)
- Acknowledge and delete, as soon as received (D9)
- Take back a message that was not delivered yet (D17)

## 1. Contacts

- Initials
- Add in person (QR + Bluetooth)
- Remove
- Labels and local nicknames

## 2. App

- Single-thread screen
- Composer with receiver picker
- Screen protection and inactivity lock

## 3. Backend on AWS

- DynamoDB storage (adapters written, D16; nothing deployed or run on AWS yet)
- Deployed websocket API
- AWS AppSync Events, for cost and performance
- Phone push notifications

## 4. Hardening

- Connection proof
- Replay and duplicates
- Protocol versioning

## 5. Later

- Media
- Group chat
- iOS
- Recovery with the secret key
