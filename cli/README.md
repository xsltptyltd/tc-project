# cli

A command-line client for local development: it does what the phone app will do, without
the phone. The connection logic is in `tc-client`; `src/main.ts` is the command line.

Run everything from the repository root.

Terminal 1 — the server:

```
npm run dev:server
```

Only contacts can write to each other (`design/DECISIONS.md` D19), and people become
contacts by meeting: one shows an invitation code, the other accepts it, both in the same
room. Create the identities and give them initials once:

```
ALICE=$(npm run -s cli -- init alice)
BOB=$(npm run -s cli -- init bob)
npm run cli -- initials alice AZ       # 1 to 4 letters, A to Z; "az" is kept as AZ
npm run cli -- initials bob BB         # stored in .tc/<name>.json, next to the keys
npm run cli -- initials alice          # prints AZ
```

Then, in the same room — `TC_ROOM` — alice invites and bob accepts within 20 seconds:

```
TC_ROOM=1 npm run cli -- invite alice
invitation from AZ in room 1, valid 20 s — in the same room, run:
  npm run cli -- accept <name> tc1.hNd7t5e4….Vv9_BTAn…

TC_ROOM=1 npm run cli -- accept bob tc1.hNd7t5e4….Vv9_BTAn…
you accepted AZ's invitation, now a contact  hNd7t5e4SM8M9dIoOwlc4JYxsmOcreIVDiBNC8Rpl7U
```

and alice's terminal shows `accepted by BB, now in your contacts as BB  w678UMh8…` and
ends. Each now has the other in their contact list — in their profile file.

These are the only keys a profile will ever encrypt to or show messages from
(`design/DECISIONS.md` D20): the keys exchanged in the invitation, checked on each side,
never an id typed in. If the server is not honest and passes off another key as the one
who accepted, `invite` says so and does not add it.

- **The room** stands in for the phones being side by side; on the phone it will be
  Bluetooth. It is never sent anywhere — not to the server, not in the code. Without
  `TC_ROOM`, `invite` and `accept` fail with a message saying so.
- **From another room**, the same code fails: `TC_ROOM=2 npm run cli -- accept carol tc1.…`
  gets "that invitation cannot be used". It is not used up: bob, in room 1, can still
  accept it.
- **A code works once**, and for 20 seconds. The lifetime is the server's, since the
  server is what refuses a late code: `INVITATION_TTL_SECONDS=60 npm run dev:server`
  (1 to 300).

## The contact list

```
npm run cli -- contacts alice
alice (AZ) — 3 contacts
  BB                w678UMh8nwaeHuht3D7oo4GMLGIBoe2VQZkGVW0ToZo
  BB2               7QVWJz7jqs4sesRYEV9NHo1XHEBHZFT6uLzT4YWgEK0
  Tennis Ann  (CD)  L6wpgVAZsiG9CKztOO380SmYRs9P7YR9ptFm2LU4SJg
```

Each contact has a **label** in your list, given when you met: their initials, or — if
your list already has someone with those — the initials and the lowest free number: `BB2`,
`BB3`… Only in your list: to the other `BB`'s contacts, they may well be `BB`. A label
never changes. An **alias** is any name you choose, shown instead, with the label kept
beside it. Neither ever leaves your device (`design/DECISIONS.md` D13).

```
npm run cli -- alias alice CD "Tennis Ann"    # by label…
npm run cli -- alias alice "Tennis Ann" Ann   # …or by alias, to change it
npm run cli -- unalias alice Ann              # back to CD
```

No two contacts in one list can have the same name, ignoring case: an alias that is
already someone else's label or alias is refused.

### Removing a contact

```
npm run cli -- remove grace JPS      # by label, alias or device id
removed JPS: you are no longer contacts,
on either side, and whatever was waiting between you is deleted
```

For both of you (`design/DECISIONS.md` D21): grace disappears from john's list too — at
once if john is connected, otherwise the next time john connects. `cli contacts` connects
first to catch up, so `npm run cli -- contacts john` shows it right away. John is not told.
Neither can write to the other any more; to be contacts again, they meet again — and
start afresh: new label, no alias.

`cli contacts` lists what the profile file holds if the server cannot be reached, and
says so.

## Writing

Contacts write to each other by name — alias, label, or device id. Terminal 2:

```
npm run cli -- chat bob --to AZ
```

Terminal 3:

```
npm run cli -- chat alice --to BB
```

Type a line in either chat and press enter; ctrl-d quits. Incoming lines show the
sender's name in your list: `< Tennis Ann  hello`. To someone who is not in your contact book, every
line is refused before it is even encrypted: `> not sent: they are not one of your
contacts`.

Typing `> delete` on its own takes back everything you sent in this chat that the other
person has not received yet (`design/DECISIONS.md` D17). What they have received stays.
The CLI cannot tell you how many were deleted: the backend does not say, because that
would tell you whether they had received them (D14).

## A network to look at: `npm run simulation`

Inviting and accepting by hand gets slow past a few people. With the server running:

```
npm run dev:server          # terminal 1
npm run simulation          # terminal 2
```

Twenty people — alice, adam, amelia, bob, betty, ben, charlie, chloe, david, emma, frank,
grace, jane, jon, jack, john, lucy, max, mia, olivia — get a profile and initials chosen
to collide (three `AB`, three `BB`, three `JS`, two `CD`, two `M`). They then meet at
random, about sixty times, through the real exchange: an invitation shown in a room, its
code accepted from the same room. Some codes are ignored, some are tried from another room
and refused. Then people give some contacts aliases — numbered ones more often. It prints
each meeting, a count per person, and one list as an example; after that, any list:

```
npm run cli -- contacts grace
npm run cli -- chat grace --to Coach
```

- **The same network again:** it prints its seed; `npm run simulation -- --seed 42`.
- **Run again**, it replaces its own twenty profiles. It will not replace a profile it did
  not make — your own `alice`, say — unless told: `npm run simulation -- --replace`.
- **The contacts are on the server too**, in memory: restart the server and it no
  longer has them. Each person keeps their list — a device does not empty a list of
  several on one answer (D21), and prints a warning instead — but nothing can be sent
  until they meet again. Run the simulation again.
- **On the DynamoDB store:** start the server with `TC_STORE=dynamodb npm run dev:server`
  and everything goes through the code the Lambdas use — with an in-memory stand-in for
  DynamoDB, not AWS.
- **To try removing:** pick two who are contacts, `npm run cli -- contacts grace`, then
  `npm run cli -- remove grace <their name in grace's list>`, and look at the other list.

## Files and settings

Identities are stored unencrypted in `./.tc/` (git-ignored). Development only.
`TC_URL` selects another server (default `ws://127.0.0.1:8787`).
