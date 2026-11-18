// `npm run simulation`: twenty people meet each other at random, through the real
// backend, so there are contact lists worth looking at (design/DECISIONS.md D13, D18).
//
// Everything goes the way it does by hand: each person is a profile in .tc/ with its
// initials, connected to the dev server; every contact is an invitation shown in a room
// and accepted from the same room, with the code passed as text. Some invitations are
// ignored, and some codes are tried from the wrong room and refused. Initials are chosen
// to collide — three ABs, three BBs, three JSs — so lists get numbered labels (BB2), and
// people then give some contacts aliases. Afterwards, look at any list:
//
//   npm run cli -- contacts alice
//
// The random choices come from a seed, printed at the start: `-- --seed <n>` makes the
// same network again. The server needs to be running (npm run dev:server), and keeps the
// contacts in memory: restart it, and it no longer has them — the lists stay (D21), but
// nothing can be sent until this is run again.
import { join } from 'node:path';
import { generateIdentity, init } from 'tc-crypto';
import { AliasRefused, ContactList, ServerError, TcClient, textInvitationCodec, type Contact } from 'tc-client';
import type { Initials } from 'tc-protocol';
import { contactLines } from './listing';
import { Profiles } from './profile';
import { roomProximity } from './room';

export interface Person {
  name: string;
  initials: Initials;
}

// Initials that collide, as real ones do.
const PEOPLE: Person[] = [
  { name: 'alice', initials: 'AB' }, // Alice Brown
  { name: 'adam', initials: 'AB' }, // Adam Baker
  { name: 'amelia', initials: 'AB' }, // Amelia Bell
  { name: 'bob', initials: 'BB' }, // Bob Baker
  { name: 'betty', initials: 'BB' }, // Betty Brown
  { name: 'ben', initials: 'BB' }, // Ben Black
  { name: 'charlie', initials: 'CD' }, // Charlie Davis
  { name: 'chloe', initials: 'CD' }, // Chloe Dunn
  { name: 'david', initials: 'DM' }, // David Miller
  { name: 'emma', initials: 'EW' }, // Emma Wilson
  { name: 'frank', initials: 'FW' }, // Frank White
  { name: 'grace', initials: 'GH' }, // Grace Hall
  { name: 'jane', initials: 'JS' }, // Jane Smith
  { name: 'john', initials: 'JS' }, // John Smith
  { name: 'jack', initials: 'JS' }, // Jack Stone
  { name: 'jean', initials: 'JPS' }, // Jean-Pierre Stone
  { name: 'lucy', initials: 'LK' }, // Lucy King
  { name: 'max', initials: 'M' }, // just "M"
  { name: 'mia', initials: 'M' }, // just "M" too
  { name: 'olivia', initials: 'OKAY' }, // Olivia Kate Anne Young
];
const ROOMS = ['kitchen', 'garden', 'office', 'café', 'library', 'gym'];
const ALIASES = [
  'Sam', 'Mom', 'Dad', 'Coach', 'Neighbour', 'Boss', 'Doc', 'Bestie', 'Tennis partner',
  'Book club', 'Landlord', 'Uncle Joe', 'Sis', 'Bro', 'Teacher', 'Dentist', 'Plumber',
  'Jo from work', 'Gran', 'Piano', 'Babysitter', '🎸 band',
];
/** Contacts to make: about six each. */
const TARGET_CONTACTS = 60;
const MAX_ATTEMPTS = 200;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A small seeded generator (mulberry32): the same seed, the same network. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const weighted = <T>(items: T[], weight: (item: T) => number): T => {
    let left = next() * items.reduce((sum, item) => sum + weight(item), 0);
    for (const item of items) if ((left -= weight(item)) < 0) return item;
    return items[items.length - 1]!;
  };
  return { next, pick, weighted };
}

function options() {
  const args = process.argv.slice(2);
  const seedAt = args.indexOf('--seed');
  const seed = seedAt === -1 ? Math.floor(Math.random() * 1_000_000) : Number(args[seedAt + 1]);
  if (!Number.isInteger(seed) || seed < 0) fail('--seed takes a whole number');
  const known = new Set(['--seed', '--replace', String(args[seedAt + 1])]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) fail(`usage: npm run simulation [-- --seed <n>] [-- --replace]\nunknown: ${unknown.join(' ')}`);
  return { seed, replace: args.includes('--replace') };
}

export interface SimulationResult {
  people: Person[];
  made: number;
  ignored: number;
  wrongRoom: number;
  aliased: number;
  oneSided: number;
  forged: number;
}

async function main(): Promise<void> {
  const { seed, replace } = options();
  const url = process.env.TC_URL ?? 'ws://127.0.0.1:8787';
  const profiles = new Profiles(join(process.cwd(), '.tc'));

  // Never overwrite a profile made by hand without being told to.
  const own = PEOPLE.filter((p) => profiles.exists(p.name) && !profiles.load(p.name).simulated).map((p) => p.name);
  if (own.length && !replace) {
    fail(
      `these profiles exist and were not made by the simulation: ${own.join(', ')}\n` +
        `run it with -- --replace to replace them (npm run simulation -- --replace)`,
    );
  }

  await init();
  // Is the server there? Checked before any profile is touched.
  const probe = new TcClient(generateIdentity(), url);
  await probe.connect().catch(() => fail(`cannot reach the server at ${url} — start it first: npm run dev:server`));
  await probe.close();

  console.log(`seed ${seed} — the same network again: npm run simulation -- --seed ${seed}`);
  const result = await simulate({ url, profiles, seed, log: console.log });
  if (result.oneSided || result.forged) process.exit(1);
}

/**
 * Makes the twenty profiles, replacing any of the same names, and has them meet through
 * the server at `url`. `log` gets what `npm run simulation` prints.
 */
export async function simulate({
  url,
  profiles,
  seed,
  log = () => {},
}: {
  url: string;
  profiles: Profiles;
  seed: number;
  log?: (line: string) => void;
}): Promise<SimulationResult> {
  const rng = random(seed);
  for (const person of PEOPLE) {
    profiles.remove(person.name);
    profiles.create(person.name, generateIdentity(), { initials: person.initials, simulated: true });
  }

  // Everyone online, each with their own contact book — their profile file.
  const clients = new Map<string, TcClient>();
  const nextInvitee = new Map<string, Array<(contact: Contact) => void>>();
  let forged = 0;
  for (const person of PEOPLE) {
    const client = new TcClient(profiles.load(person.name), url, profiles.contactBook(person.name));
    const waiting: Array<(contact: Contact) => void> = [];
    client.onInvitee((contact) => waiting.shift()?.(contact));
    client.onForgedInvitee(() => forged++);
    await client.connect();
    clients.set(person.name, client);
    nextInvitee.set(person.name, waiting);
  }
  const client = (person: Person) => clients.get(person.name)!;
  const book = (person: Person) => new ContactList(profiles.contactBook(person.name));
  const idOf = (person: Person) => profiles.load(person.name).deviceId;

  // Some people get out more than others.
  const sociable = new Map(PEOPLE.map((p) => [p.name, 0.15 + rng.next()]));
  let made = 0;
  let ignored = 0;
  let wrongRoom = 0;
  log(`\n${PEOPLE.length} people meet, in ${ROOMS.length} rooms:`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && made < TARGET_CONTACTS; attempt++) {
    const inviter = rng.weighted(PEOPLE, (p) => sociable.get(p.name)!);
    const known = new Set((await book(inviter).list()).map((c) => c.deviceId));
    const strangers = PEOPLE.filter((p) => p !== inviter && !known.has(idOf(p)));
    if (strangers.length === 0) continue;
    const invitee = rng.weighted(strangers, (p) => sociable.get(p.name)!);
    const room = rng.pick(ROOMS);
    const who = `${inviter.name} (${inviter.initials}) → ${invitee.name} (${invitee.initials})`;

    const open = await client(inviter).invite(inviter.initials, roomProximity(room));
    // What the inviter's screen shows, read by the other person.
    const read = textInvitationCodec.decode(textInvitationCodec.encode(open.invitation))!;
    const roll = rng.next();

    if (roll < 0.12) {
      open.close();
      ignored++;
      log(`  ${who}, ${room}: nobody accepts the code`);
      continue;
    }
    if (roll < 0.24) {
      const elsewhere = rng.pick(ROOMS.filter((r) => r !== room));
      const refused = await client(invitee)
        .accept(read, invitee.initials, roomProximity(elsewhere))
        .then(() => false, (error) => error instanceof ServerError && error.code === 'invitation_invalid');
      if (!refused) throw new Error(`a code accepted from the wrong room was not refused (${who})`);
      open.close();
      wrongRoom++;
      log(`  ${who}: code shown in the ${room}, tried from the ${elsewhere} — refused`);
      continue;
    }

    const added = new Promise<Contact>((resolve) => nextInvitee.get(inviter.name)!.push(resolve));
    const asInvitee = await client(invitee).accept(read, invitee.initials, roomProximity(room));
    const asInviter = await added;
    made++;
    const labels = `${inviter.name} lists ${asInviter.label}, ${invitee.name} lists ${asInvitee.label}`;
    log(`  ${who}, ${room}: contacts — ${labels}`);
  }

  // People give some contacts a name of their own: more often the numbered ones.
  let aliased = 0;
  for (const person of PEOPLE) {
    const list = book(person);
    for (const contact of await list.list()) {
      if (rng.next() >= (/\d/.test(contact.label) ? 0.5 : 0.2)) continue;
      for (let tries = 0; tries < 5; tries++) {
        try {
          await list.setAlias(contact.deviceId, rng.pick(ALIASES));
          aliased++;
          break;
        } catch (error) {
          if (!(error instanceof AliasRefused)) throw error; // already used in this list
        }
      }
    }
  }

  // Every contact is on both sides.
  const byId = new Map(PEOPLE.map((p) => [idOf(p), p]));
  let oneSided = 0;
  for (const person of PEOPLE) {
    for (const contact of await book(person).list()) {
      const other = byId.get(contact.deviceId)!;
      if (!(await book(other).get(idOf(person)))) oneSided++;
    }
  }

  log(`\n${made} contacts made, ${ignored} codes ignored, ${wrongRoom} refused from the wrong room, ${aliased} aliases given`);
  log(oneSided === 0 && forged === 0 ? 'every contact is on both sides' : `PROBLEM: ${oneSided} one-sided, ${forged} forged`);

  log('\nwho knows how many:');
  const lists = new Map<Person, Contact[]>();
  for (const person of PEOPLE) lists.set(person, await book(person).list());
  for (const person of PEOPLE) {
    const contacts = lists.get(person)!;
    const numbered = contacts.filter((c) => /\d/.test(c.label)).length;
    const aliases = contacts.filter((c) => c.alias).length;
    log(
      `  ${person.name.padEnd(8)} ${person.initials.padEnd(5)} ${String(contacts.length).padStart(2)} ` +
        `contact${contacts.length === 1 ? '' : 's'}` +
        `${numbered ? `, ${numbered} numbered` : ''}${aliases ? `, ${aliases} aliased` : ''}`,
    );
  }

  // The list with the most going on.
  const interesting = (contacts: Contact[]) =>
    contacts.filter((c) => /\d/.test(c.label)).length * 2 + contacts.filter((c) => c.alias).length + contacts.length / 10;
  const [showcase] = [...lists.entries()].sort((a, b) => interesting(b[1]) - interesting(a[1]))[0]!;
  log(`\nfor example, ${showcase.name}'s list (npm run cli -- contacts ${showcase.name}):`);
  for (const line of contactLines(lists.get(showcase)!)) log(`  ${line}`);
  log(`\nlists of the others: npm run cli -- contacts <name>, for ${PEOPLE.map((p) => p.name).join(', ')}`);

  await Promise.all([...clients.values()].map((c) => c.close()));
  return { people: PEOPLE, made, ignored, wrongRoom, aliased, oneSided, forged };
}

// Run as a command, not when a test imports it.
if (process.argv[1]?.endsWith('simulation.ts')) main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
