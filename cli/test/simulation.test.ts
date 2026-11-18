// The simulation, run for real: twenty profiles in a temporary directory, meeting through
// a local server — twice: with the server's store in memory, and with the DynamoDB store
// the Lambdas use, talking to the stand-in client instead of AWS.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nameOf } from 'tc-client';
import { init } from 'tc-crypto';
import { startLocalServer, type LocalServer } from '../../ws-backend/lambdas/local/server';
import { DynamoStore } from '../../ws-backend/lambdas/src/adapters/dynamodb-store';
import type { ContactStore, Store } from '../../ws-backend/lambdas/src/core/ports';
import { FakeDynamoDB } from '../../ws-backend/lambdas/test/fake-dynamodb';
import { Profiles } from '../src/profile';
import { simulate, type SimulationResult } from '../src/simulation';

interface Backend {
  store?: Store & ContactStore;
  /** The table, when there is one: to check what is really in it. */
  table?: FakeDynamoDB;
}

const backends: Array<[string, () => Backend]> = [
  ['in memory', () => ({})],
  [
    'on DynamoDB (stand-in client)',
    () => {
      const table = new FakeDynamoDB(25);
      return { store: new DynamoStore('table', table), table };
    },
  ],
];

describe.each(backends)('npm run simulation, with the server %s', (_name, backend) => {
  let server: LocalServer<Store & ContactStore>;
  let table: FakeDynamoDB | undefined;
  let dir: string;
  let profiles: Profiles;
  let result: SimulationResult;
  const lines: string[] = [];

  beforeAll(async () => {
    await init();
    const chosen = backend();
    table = chosen.table;
    server = await startLocalServer(0, '127.0.0.1', { store: chosen.store });
    dir = mkdtempSync(join(tmpdir(), 'tc-simulation-'));
    profiles = new Profiles(dir);
    result = await simulate({ url: server.url, profiles, seed: 42, log: (line) => lines.push(line) });
  }, 60_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listOf = (name: string) => profiles.load(name).contacts ?? [];

  it('makes twenty people with initials, marked as simulated', () => {
    expect(result.people).toHaveLength(20);
    for (const person of result.people) {
      expect(profiles.load(person.name)).toMatchObject({ initials: person.initials, simulated: true });
    }
  });

  it('makes its sixty contacts, some codes ignored and some refused from the wrong room', () => {
    expect(result.made).toBe(60);
    expect(result.ignored).toBeGreaterThan(0);
    expect(result.wrongRoom).toBeGreaterThan(0);
    const total = result.people.reduce((sum, p) => sum + listOf(p.name).length, 0);
    expect(total).toBe(2 * result.made);
  });

  it('makes every contact mutual, on the devices and on the server, and nothing forged', async () => {
    expect(result.oneSided).toBe(0);
    expect(result.forged).toBe(0);
    for (const person of result.people) {
      const me = profiles.load(person.name).deviceId;
      for (const contact of listOf(person.name)) {
        expect(await server.store.isContact(me, contact.deviceId)).toBe(true);
      }
      expect((await server.store.listContacts(me)).length).toBe(listOf(person.name).length);
    }
  });

  it('keeps the contacts where the server keeps everything: two items per contact in the table', () => {
    if (!table) return; // in memory: nothing more to look at
    const contactItems = [...table.items.keys()].filter((key) => key.includes('|CONTACT#'));
    expect(contactItems).toHaveLength(2 * result.made);
  });

  it('gives each list unique names, numbered labels where initials repeat, and some aliases', () => {
    let numbered = 0;
    let aliased = 0;
    for (const person of result.people) {
      const contacts = listOf(person.name);
      const names = contacts.map((c) => nameOf(c).toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      for (const contact of contacts) {
        expect(contact.label.startsWith(contact.initials)).toBe(true);
        if (contact.label !== contact.initials) numbered++;
        if (contact.alias) aliased++;
      }
    }
    expect(numbered).toBeGreaterThan(5);
    expect(aliased).toBe(result.aliased);
    expect(aliased).toBeGreaterThan(10);
  });

  it('prints a list to look at, and how to see the others', () => {
    expect(lines.some((line) => line.includes('every contact is on both sides'))).toBe(true);
    expect(lines.some((line) => line.trimStart().startsWith('for example'))).toBe(true);
  });
});
