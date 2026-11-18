// Labels and aliases in one device's contact list (D13, D20).
import { describe, expect, it } from 'vitest';
import {
  AliasRefused,
  ALIAS_MAX_LENGTH,
  byName,
  ContactList,
  labelFor,
  MemoryContactBook,
  nameOf,
  NotAContact,
} from '../src';

let n = 0;
const id = () => `device${String(n++).padStart(37, '0')}`;
const list = () => new ContactList(new MemoryContactBook());

describe('a label', () => {
  it('is the initials when free, or the initials with the lowest free number from 2', () => {
    expect(labelFor('BB', [])).toBe('BB');
    expect(labelFor('BB', ['BB'])).toBe('BB2');
    expect(labelFor('BB', ['BB', 'BB2'])).toBe('BB3');
    expect(labelFor('BB', ['BB', 'BB3'])).toBe('BB2'); // a gap is reused
    expect(labelFor('B', ['BB', 'BB2'])).toBe('B'); // B is not BB
  });

  it('does not take a name in use as an alias, whatever its case', () => {
    expect(labelFor('SAM', ['sam'])).toBe('SAM2');
  });
});

describe('meeting people', () => {
  it('numbers the second, third… person with the same initials, in this list only', async () => {
    const alice = list();
    const [b1, b2, b3] = [id(), id(), id()];
    expect((await alice.addMet({ deviceId: b1, initials: 'BB' })).label).toBe('BB');
    expect((await alice.addMet({ deviceId: b2, initials: 'BB' })).label).toBe('BB2');
    expect((await alice.addMet({ deviceId: b3, initials: 'BB' })).label).toBe('BB3');

    const carol = list(); // another device: its own numbering
    expect((await carol.addMet({ deviceId: b3, initials: 'BB' })).label).toBe('BB');
  });

  it('changes nothing when meeting someone already in the list, even with new initials', async () => {
    const alice = list();
    const bob = id();
    await alice.addMet({ deviceId: bob, initials: 'BB' });
    await alice.setAlias(bob, 'Sam');
    expect(await alice.addMet({ deviceId: bob, initials: 'RB' })).toEqual({
      deviceId: bob,
      initials: 'BB',
      label: 'BB',
      alias: 'Sam',
    });
    expect(await alice.list()).toHaveLength(1);
  });

  it('keeps a label for good: an alias does not free it', async () => {
    const alice = list();
    const [b1, b2] = [id(), id()];
    await alice.addMet({ deviceId: b1, initials: 'BB' });
    await alice.setAlias(b1, 'Sam');
    expect((await alice.addMet({ deviceId: b2, initials: 'BB' })).label).toBe('BB2');
  });

  it('does not give a new contact a label already shown as an alias', async () => {
    const alice = list();
    const [x, y] = [id(), id()];
    await alice.addMet({ deviceId: x, initials: 'AZ' });
    await alice.setAlias(x, 'CD');
    expect((await alice.addMet({ deviceId: y, initials: 'CD' })).label).toBe('CD2');
  });

  it('gives two people met at the same moment two different labels', async () => {
    const alice = list();
    const labels = await Promise.all([id(), id(), id()].map((deviceId) => alice.addMet({ deviceId, initials: 'JS' })));
    expect(labels.map((c) => c.label).sort()).toEqual(['JS', 'JS2', 'JS3']);
  });
});

describe('an alias', () => {
  async function aliceWith(...initials: string[]) {
    const alice = list();
    const ids: string[] = [];
    for (const i of initials) ids.push((await alice.addMet({ deviceId: id(), initials: i })).deviceId);
    return { alice, ids };
  }

  it('is shown instead of the label, and can be taken away again', async () => {
    const { alice, ids } = await aliceWith('BB', 'BB');
    const sam = await alice.setAlias(ids[1]!, '  Sam ');
    expect(sam).toMatchObject({ label: 'BB2', alias: 'Sam' });
    expect(nameOf(sam)).toBe('Sam');
    const back = await alice.setAlias(ids[1]!, undefined);
    expect(back).toEqual({ deviceId: ids[1], initials: 'BB', label: 'BB2' });
    expect(nameOf(back)).toBe('BB2');
  });

  it('can be anything a person would write, up to its length', async () => {
    const { alice, ids } = await aliceWith('BB');
    for (const alias of ['Tennis partner', 'Zoë', '🎸 band', '王小明', 'x'.repeat(ALIAS_MAX_LENGTH)]) {
      expect((await alice.setAlias(ids[0]!, alias)).alias).toBe(alias);
    }
  });

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(ALIAS_MAX_LENGTH + 1)],
    ['with a control character', 'Sam\nBoss'],
  ])('is refused when %s', async (_label, alias) => {
    const { alice, ids } = await aliceWith('BB');
    await expect(alice.setAlias(ids[0]!, alias)).rejects.toThrow(AliasRefused);
  });

  it("is refused when it is another contact's alias or label, whatever the case", async () => {
    const { alice, ids } = await aliceWith('BB', 'BB', 'CD');
    await alice.setAlias(ids[0]!, 'Sam');
    await expect(alice.setAlias(ids[1]!, 'sam')).rejects.toThrow('"Sam" is already the name of another contact');
    await expect(alice.setAlias(ids[1]!, 'cd')).rejects.toThrow('"CD" is already the name of another contact');
    await expect(alice.setAlias(ids[2]!, 'BB2')).rejects.toThrow(AliasRefused);
  });

  it("may be the contact's own label, or its own alias again", async () => {
    const { alice, ids } = await aliceWith('BB');
    await alice.setAlias(ids[0]!, 'Sam');
    await expect(alice.setAlias(ids[0]!, 'SAM')).resolves.toMatchObject({ alias: 'SAM' });
    await expect(alice.setAlias(ids[0]!, 'bb')).resolves.toMatchObject({ alias: 'bb' });
  });

  it('is only for contacts', async () => {
    await expect(list().setAlias(id(), 'Sam')).rejects.toThrow(NotAContact);
  });
});

describe('finding a contact', () => {
  it('by alias, by label — even when it has an alias — or by device id, ignoring case', async () => {
    const alice = list();
    const [b1, b2] = [id(), id()];
    await alice.addMet({ deviceId: b1, initials: 'BB' });
    await alice.addMet({ deviceId: b2, initials: 'BB' });
    await alice.setAlias(b2, 'Tennis partner');

    expect((await alice.find('bb'))?.deviceId).toBe(b1);
    expect((await alice.find(' tennis PARTNER '))?.deviceId).toBe(b2);
    expect((await alice.find('BB2'))?.deviceId).toBe(b2);
    expect((await alice.find(b1))?.deviceId).toBe(b1);
    expect(await alice.find('BB3')).toBeUndefined();
  });
});

describe('a list, sorted', () => {
  it('goes by name, numbers in numeric order, case ignored', async () => {
    const alice = list();
    for (let i = 0; i < 11; i++) await alice.addMet({ deviceId: id(), initials: 'BB' });
    const zoe = await alice.addMet({ deviceId: id(), initials: 'ZZ' });
    await alice.setAlias(zoe.deviceId, 'anna');
    const names = byName(await alice.list()).map(nameOf);
    expect(names).toEqual(['anna', 'BB', 'BB2', 'BB3', 'BB4', 'BB5', 'BB6', 'BB7', 'BB8', 'BB9', 'BB10', 'BB11']);
  });
});
