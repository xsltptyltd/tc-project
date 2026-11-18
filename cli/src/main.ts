// Command-line client for local development. Identities are stored unencrypted in
// ./.tc/<name>.json — fine for trying things out, not for real use.
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { generateIdentity, init } from 'tc-crypto';
import { DeviceIdSchema, INITIALS_MAX_LENGTH, type Initials } from 'tc-protocol';
import {
  AliasRefused,
  ContactList,
  NotAContact,
  ProximityUnavailable,
  ServerError,
  TcClient,
  textInvitationCodec,
  type Contact,
  type SyncOutcome,
} from 'tc-client';
import { DELETE_COMMAND, parseLine } from './commands';
import { contactLines } from './listing';
import { parseInitials, Profiles, type Profile } from './profile';
import { ROOM_VARIABLE, roomProximity } from './room';

const USAGE = `usage:
  cli init <name>                  create an identity and print its device id
  cli id <name>                    print the device id
  cli initials <name> [initials]   set your initials (1 to ${INITIALS_MAX_LENGTH} letters), or print them
  cli invite <name>                show an invitation code and wait for someone to accept it
  cli accept <name> <code>         accept the invitation code shown by someone else;
                                   you are then contacts, and only contacts can write
  cli contacts <name>              list the contacts met in person — the only keys ever used —
                                   by alias, or by label (initials, numbered if taken: BB2)
  cli alias <name> <contact> <alias>   call a contact something else, on this device only
  cli unalias <name> <contact>     back to the contact's label
  cli remove <name> <contact>      stop being contacts, on both sides: you disappear from
                                   their list too, and messages waiting between you are deleted
  cli chat <name> --to <contact>   connect; each line typed is sent, incoming lines are printed;
                                   "${DELETE_COMMAND}" takes back what they have not received yet
  <contact> is an alias, a label or a device id; quote an alias with spaces in it.

environment:
  TC_URL   websocket url (default ws://127.0.0.1:8787)
  ${ROOM_VARIABLE}  the room you are in, required to invite or accept: both sides must set
           the same one. Never sent anywhere. Stands in for Bluetooth proximity.
  how long an invitation lasts is the server's setting: INVITATION_TTL_SECONDS (default 20)`;

const profiles = new Profiles(join(process.cwd(), '.tc'));
const serverUrl = () => process.env.TC_URL ?? 'ws://127.0.0.1:8787';

function load(name: string): Profile {
  try {
    return profiles.load(name);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function initialsOf(name: string, profile: Profile): Initials {
  if (!profile.initials) fail(`"${name}" has no initials yet — run: cli initials ${name} <initials>`);
  return profile.initials;
}

/** Runs `step`, turning "no proximity" into its own clear message. */
async function nearby<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ProximityUnavailable) fail(error.message);
    throw error;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A client that trusts exactly the keys in this profile's contact book (D20). */
function clientFor(name: string, profile: Profile): TcClient {
  return new TcClient(profile, serverUrl(), profiles.contactBook(name));
}

/** Connected, with contacts the other side removed meanwhile dropped (D21). */
async function connected(name: string, profile: Profile): Promise<TcClient> {
  const client = clientFor(name, profile);
  await client.connect();
  warnIfRefused(await client.syncContacts());
  return client;
}

/** A sync that would have emptied the list is not followed: say so (D21). */
function warnIfRefused(outcome: SyncOutcome): void {
  if (outcome !== 'refused') return;
  console.error('warning: the server knows none of your contacts. Your list was left as it is;');
  console.error('  if the server was restarted or replaced, meet again to write to them.');
}

async function main(): Promise<void> {
  const [command, name, ...rest] = process.argv.slice(2);
  if (!command || !name || !/^[A-Za-z0-9_-]+$/.test(name)) fail(USAGE);
  await init();

  if (command === 'init') {
    if (profiles.exists(name)) fail(`identity "${name}" already exists`);
    const identity = generateIdentity();
    profiles.create(name, identity);
    console.log(identity.deviceId);
    return;
  }

  if (command === 'id') {
    console.log(load(name).deviceId);
    return;
  }

  if (command === 'initials') {
    if (rest.length === 0) {
      console.log(initialsOf(name, load(name)));
      return;
    }
    const initials = rest.length === 1 ? parseInitials(rest[0]!) : undefined;
    if (!initials) fail(`initials are 1 to ${INITIALS_MAX_LENGTH} letters, A to Z — for example: cli initials ${name} AZ`);
    load(name); // a clear message if the identity does not exist
    profiles.setInitials(name, initials);
    console.log(`${name} is now ${initials}`);
    return;
  }

  if (command === 'invite') {
    if (rest.length !== 0) fail(USAGE);
    const profile = load(name);
    const initials = initialsOf(name, profile);
    const client = await connected(name, profile);
    const accepted = new Promise<Contact>((resolve) => client.onInvitee(resolve));
    client.onClose(() => fail('connection closed'));
    client.onForgedInvitee(() => {
      console.log('warning: the server reported someone accepting, with a key that was not sealed');
      console.log('  with this invitation: ignored, not added. The server may not be honest.');
    });
    const room = process.env[ROOM_VARIABLE];
    const { invitation, expiresIn } = await nearby(() => client.invite(initials, roomProximity(room)));
    // The room is not part of the command to copy: being in it is the point.
    console.log(`invitation from ${initials} in room ${room?.trim()}, valid ${expiresIn} s — in the same room, run:`);
    console.log(`  npm run cli -- accept <name> ${textInvitationCodec.encode(invitation)}`);
    const outcome = await Promise.race([
      accepted,
      new Promise<undefined>((resolve) => setTimeout(resolve, expiresIn * 1000)),
    ]);
    if (!outcome) fail('expired: nobody accepted it');
    console.log(`accepted by ${outcome.initials}, now in your contacts as ${outcome.label}  ${outcome.deviceId}`);
    process.exit(0);
  }

  if (command === 'accept') {
    const invitation = rest.length === 1 ? textInvitationCodec.decode(rest[0]!) : undefined;
    if (!invitation) fail(`not an invitation code — copy the whole code, starting with "tc1."`);
    const profile = load(name);
    const initials = initialsOf(name, profile);
    const client = await connected(name, profile);
    try {
      const proximity = roomProximity(process.env[ROOM_VARIABLE]);
      const inviter = await nearby(() => client.accept(invitation, initials, proximity));
      console.log(`you accepted ${inviter.initials}'s invitation, now in your contacts as ${inviter.label}  ${inviter.deviceId}`);
    } catch (error) {
      if (error instanceof ServerError && error.code === 'invitation_invalid') {
        fail(
          'that invitation cannot be used: you are not in the same room as them, ' +
            'or it expired, or it was already accepted',
        );
      }
      throw error;
    }
    await client.close();
    return;
  }

  if (command === 'contacts') {
    if (rest.length !== 0) fail(USAGE);
    // Like an app being opened: first drop whoever removed this person meanwhile (D21).
    let offline = false;
    try {
      await (await connected(name, load(name))).close();
    } catch {
      offline = true;
    }
    const profile = load(name);
    const contacts = profile.contacts ?? [];
    const count = `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`;
    console.log(`${name} (${profile.initials ?? 'no initials'}) — ${count}`);
    if (contacts.length === 0) console.log(`  nobody yet: meet someone with ${ROOM_VARIABLE}=1 npm run cli -- invite ${name}`);
    for (const line of contactLines(contacts)) console.log(`  ${line}`);
    if (offline) console.log(`(server unreachable at ${serverUrl()}: contacts removed by the other side may still show)`);
    return;
  }

  if (command === 'remove') {
    if (rest.length !== 1) fail(USAGE);
    const profile = load(name);
    const contact = await new ContactList(profiles.contactBook(name)).find(rest[0]!);
    if (!contact) fail(`${name} has no contact called "${rest[0]}" — see: npm run cli -- contacts ${name}`);
    const client = await connected(name, profile);
    await client.removeContact(contact.deviceId);
    await client.close();
    console.log(`removed ${contact.alias ? `${contact.alias} (${contact.label})` : contact.label}: you are no longer contacts,`);
    console.log('on either side, and whatever was waiting between you is deleted');
    return;
  }

  if (command === 'alias' || command === 'unalias') {
    const [who, ...words] = rest;
    if (!who || (command === 'alias' ? words.length === 0 : words.length !== 0)) fail(USAGE);
    load(name);
    const list = new ContactList(profiles.contactBook(name));
    const contact = await list.find(who);
    if (!contact) fail(`${name} has no contact called "${who}" — see: npm run cli -- contacts ${name}`);
    try {
      const updated = await list.setAlias(contact.deviceId, command === 'alias' ? words.join(' ') : undefined);
      console.log(
        updated.alias
          ? `${updated.label} is now shown as "${updated.alias}"`
          : `${updated.label} is shown as ${updated.label} again`,
      );
    } catch (error) {
      if (error instanceof AliasRefused) fail(error.message);
      throw error;
    }
    return;
  }

  if (command === 'chat') {
    if (rest[0] !== '--to' || !rest[1] || rest.length !== 2) fail(USAGE);
    const identity = load(name);
    // A name from the contact list, or a device id — which need not be a contact, but
    // then nothing will be sent.
    const found = await new ContactList(profiles.contactBook(name)).find(rest[1]);
    const to = DeviceIdSchema.safeParse(found?.deviceId ?? rest[1]);
    if (!to.success) fail(`${name} has no contact called "${rest[1]}" — see: npm run cli -- contacts ${name}`);
    const client = clientFor(name, identity);
    client.onMessage((m) => console.log(`< ${m.name}  ${m.text}`));
    let quitting = false;
    client.onClose(() => {
      if (!quitting) fail('connection closed');
    });
    await client.connect();
    warnIfRefused(await client.syncContacts());
    const contact = await profiles.contactBook(name).get(to.data);
    console.log(`you are    ${identity.initials ?? '?'}  ${identity.deviceId}`);
    if (contact) console.log(`writing to ${contact.alias ?? contact.label}  ${to.data}`);
    else console.log(`${to.data} is not one of your contacts: nothing you type will be sent`);
    console.log('connected — type a message and press enter (ctrl-d to quit)');
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.kind === 'skip') continue;
      if (parsed.kind === 'delete') {
        // The backend does not say what it deleted: that would say what was delivered.
        client.unsend(to.data);
        console.log('> deleted whatever they had not received yet');
        continue;
      }
      try {
        await client.send(to.data, parsed.text);
        console.log('> sent');
      } catch (error) {
        const notAContact =
          error instanceof NotAContact || (error instanceof ServerError && error.code === 'not_a_contact');
        if (!notAContact) throw error;
        console.log('> not sent: they are not one of your contacts — meet and add each other first');
        console.log(`  (${ROOM_VARIABLE}=1 npm run cli -- invite ${name}, then accept on their side)`);
      }
    }
    quitting = true;
    await client.close();
    return;
  }

  fail(USAGE);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
