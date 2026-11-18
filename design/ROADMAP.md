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
- Initials, and one-time invitation codes that exchange keys and initials — in memory,
  from the terminal (D13, D18)
- Contact list: labels numbered per list (`BB2`), aliases, listing (D13);
  `npm run simulation` for a network of twenty to look at
- Proximity behind an interface, a room in the terminal, never sent to the backend (D18)
- Only contacts can write to each other; accepting an invitation makes two contacts (D19)
- Remove a contact, for both: both lists, waiting messages deleted (D5, D21)
- Each device encrypts only to, and shows only messages from, keys it exchanged in person
  (D20); the CLI keeps them in its profile file

## 1. Contacts

- Add in person: both confirm (D5); QR code and universal link in the app; Bluetooth
  proximity (D1)

## 2. App

Done: contacts list, add someone with a text code (a room field stands in for
Bluetooth), one conversation per contact, alias, take back, remove; the contact book in
secure storage (D20).

- Single-thread screen
- Composer with receiver picker
- Screen protection and inactivity lock

## 3. Backend on AWS

- DynamoDB storage: messages, connections, invitations, contacts (adapters written, D16;
  nothing deployed or run on AWS yet)
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
