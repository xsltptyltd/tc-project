# Roadmap

In rough order. Each line is a goal, not a specification.

## Done

- Key-pair identity, signed connection
- Encrypted one-to-one messages
- Local server, command-line client, basic Android app

## 1. Messaging

- Delayed messages when not online
- Acknowledge and delete
- 24-hour expiry

## 2. Contacts

- Initials
- Add in person (QR + Bluetooth)
- Remove
- Labels and local nicknames

## 3. App

- Single-thread screen
- Composer with receiver picker
- Screen protection and inactivity lock

## 4. Backend on AWS

- DynamoDB storage
- Deployed websocket API
- AWS AppSync Events, for cost and performance
- Phone push notifications

## 5. Hardening

- Connection proof
- Replay and duplicates
- Protocol versioning

## 6. Later

- Media
- Group chat
- iOS
- Recovery with the secret key
