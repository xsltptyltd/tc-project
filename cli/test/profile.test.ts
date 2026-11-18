import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ContactList } from 'tc-client';
import { generateIdentity, init } from 'tc-crypto';
import { parseInitials, Profiles } from '../src/profile';

beforeAll(() => init());

describe('initials typed on the command line', () => {
  it.each([
    ['AZ', 'AZ'],
    ['az', 'AZ'],
    ['Pc', 'PC'],
    [' abcd ', 'ABCD'],
    ['a', 'A'],
  ])('%j is stored as %j', (typed, stored) => {
    expect(parseInitials(typed)).toBe(stored);
  });

  it.each(['', 'ABCDE', 'A1', 'A Z', 'É', 'ß', 'A.', '-'])('%j is refused', (typed) => {
    expect(parseInitials(typed)).toBeUndefined();
  });
});

describe('a local profile', () => {
  let dir: string;
  const newProfiles = () => new Profiles((dir = mkdtempSync(join(tmpdir(), 'tc-cli-'))));
  newProfiles(); // so that every test has a directory, even one that makes its own
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps its keys when initials are set, and changes them when set again', () => {
    const profiles = newProfiles();
    const identity = generateIdentity();
    profiles.create('alice', identity);
    expect(profiles.load('alice')).toEqual(identity);

    profiles.setInitials('alice', 'AZ');
    expect(profiles.load('alice')).toEqual({ ...identity, initials: 'AZ' });
    profiles.setInitials('alice', 'AL');
    expect(profiles.load('alice')).toEqual({ ...identity, initials: 'AL' });
  });

  it('is readable by its owner only', () => {
    const profiles = newProfiles();
    profiles.create('alice', generateIdentity());
    profiles.setInitials('alice', 'AZ');
    expect(statSync(profiles.path('alice')).mode & 0o777).toBe(0o600);
  });

  it('is a file named after the profile, holding the initials', () => {
    const profiles = newProfiles();
    profiles.create('bob', generateIdentity());
    profiles.setInitials('bob', 'BB');
    expect(JSON.parse(readFileSync(join(dir, 'bob.json'), 'utf8')).initials).toBe('BB');
  });

  it('cannot be created twice, or given initials before it exists', () => {
    const profiles = newProfiles();
    profiles.create('alice', generateIdentity());
    expect(() => profiles.create('alice', generateIdentity())).toThrow('already exists');
    expect(() => profiles.setInitials('carol', 'CC')).toThrow('cli init carol');
  });

  it('keeps a contact book in the file, in the order met, with the keys untouched', async () => {
    const profiles = newProfiles();
    const identity = generateIdentity();
    const [bob, carol] = [generateIdentity().deviceId, generateIdentity().deviceId];
    profiles.create('alice', identity, { initials: 'AZ' });
    const list = new ContactList(profiles.contactBook('alice'));

    expect(await list.get(bob)).toBeUndefined();
    await list.addMet({ deviceId: bob, initials: 'BB' });
    await list.addMet({ deviceId: carol, initials: 'BB' });
    await list.setAlias(bob, 'Sam'); // replaced in place

    expect(profiles.load('alice')).toEqual({
      ...identity,
      initials: 'AZ',
      contacts: [
        { deviceId: bob, initials: 'BB', label: 'BB', alias: 'Sam' },
        { deviceId: carol, initials: 'BB', label: 'BB2' },
      ],
    });
    expect(statSync(profiles.path('alice')).mode & 0o777).toBe(0o600);
  });

  it('reads the book from the file each time, so another terminal’s additions count', async () => {
    const profiles = newProfiles();
    profiles.create('alice', generateIdentity());
    const bob = generateIdentity().deviceId;
    const inChat = profiles.contactBook('alice');
    await new ContactList(new Profiles(dir).contactBook('alice')).addMet({ deviceId: bob, initials: 'BB' });
    expect(await inChat.get(bob)).toMatchObject({ deviceId: bob, label: 'BB' });
  });

  it('gives contacts saved before labels existed their labels, in the order they were met', () => {
    const profiles = newProfiles();
    const identity = generateIdentity();
    const [b1, b2, c] = [generateIdentity().deviceId, generateIdentity().deviceId, generateIdentity().deviceId];
    const old = { ...identity, contacts: [{ deviceId: b1, initials: 'BB' }, { deviceId: c, initials: 'CD' }, { deviceId: b2, initials: 'BB' }] };
    writeFileSync(join(dir, 'old.json'), JSON.stringify(old));
    expect(profiles.load('old').contacts?.map((x) => x.label)).toEqual(['BB', 'CD', 'BB2']);
  });

  it('forgets a removed contact entirely, leaving the others and their labels as they were', async () => {
    const profiles = newProfiles();
    profiles.create('alice', generateIdentity());
    const list = new ContactList(profiles.contactBook('alice'));
    const [b1, b2, b3] = [generateIdentity().deviceId, generateIdentity().deviceId, generateIdentity().deviceId];
    for (const deviceId of [b1, b2, b3]) await list.addMet({ deviceId, initials: 'BB' });
    await list.setAlias(b1, 'Sam');

    expect(await list.remove(b1)).toBe(true);
    expect(await list.remove(b1)).toBe(false); // gone already
    expect(profiles.load('alice').contacts?.map((c) => c.label)).toEqual(['BB2', 'BB3']);
    expect(JSON.stringify(profiles.load('alice'))).not.toContain('Sam');
    expect((await list.addMet({ deviceId: generateIdentity().deviceId, initials: 'BB' })).label).toBe('BB'); // free again
  });

  it('can be removed, and marked as made by the simulation', () => {
    const profiles = newProfiles();
    profiles.create('max', generateIdentity(), { initials: 'M', simulated: true });
    expect(profiles.load('max')).toMatchObject({ initials: 'M', simulated: true });
    profiles.remove('max');
    expect(profiles.exists('max')).toBe(false);
  });
});
