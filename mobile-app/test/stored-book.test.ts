// The phone's contact book, on a Map instead of the platform's secure storage.
import { describe, expect, it } from 'vitest';
import { PIECE_CHARS, storedContactBook, type KeyValueStorage } from '../src/stored-book';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: KeyValueStorage = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
  return { values, storage };
}

const contact = (n: number, alias?: string) => ({
  deviceId: `device-${String(n).padStart(36, '0')}`,
  initials: 'BB',
  label: n === 1 ? 'BB' : `BB${n}`,
  ...(alias !== undefined && { alias }),
});

describe("the phone's contact book", () => {
  it('is empty on a new device', async () => {
    const book = storedContactBook(memoryStorage().storage);
    expect(await book.list()).toEqual([]);
    expect(await book.get(contact(1).deviceId)).toBeUndefined();
  });

  it('keeps contacts in the order they were added, and replaces one in place', async () => {
    const book = storedContactBook(memoryStorage().storage);
    await book.put(contact(1));
    await book.put(contact(2));
    await book.put(contact(1, 'Sam'));
    expect(await book.list()).toEqual([contact(1, 'Sam'), contact(2)]);
    expect(await book.get(contact(2).deviceId)).toEqual(contact(2));
  });

  it('forgets a removed contact entirely', async () => {
    const { values, storage } = memoryStorage();
    const book = storedContactBook(storage);
    await book.put(contact(1, 'Sam'));
    await book.remove(contact(1).deviceId);
    await book.remove(contact(1).deviceId); // again: nothing to do
    expect(await book.list()).toEqual([]);
    expect([...values.values()].join('')).not.toContain('Sam');
  });

  it('is still there when the app starts again', async () => {
    const { storage } = memoryStorage();
    const first = storedContactBook(storage);
    for (let n = 1; n <= 40; n++) await first.put(contact(n, n % 3 === 0 ? `🎸 band ${n}` : undefined));
    await first.remove(contact(7).deviceId);
    const again = storedContactBook(storage);
    expect(await again.list()).toEqual(await first.list());
    expect((await again.list()).length).toBe(39);
  });

  it('writes a long list as small pieces, and leaves no old piece behind', async () => {
    const { values, storage } = memoryStorage();
    const book = storedContactBook(storage);
    for (let n = 1; n <= 40; n++) await book.put(contact(n, `🎸 ${n}`));
    const pieces = [...values.entries()].filter(([key]) => !key.endsWith('.head'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const [, value] of pieces) {
      expect([...value].length).toBeLessThanOrEqual(PIECE_CHARS);
      expect(new TextEncoder().encode(value).length).toBeLessThan(2048);
    }
    const head = JSON.parse(values.get('tc.contacts.head')!) as { version: number; pieces: number };
    expect(pieces.length).toBe(head.pieces);
    expect(pieces.every(([key]) => key.startsWith(`tc.contacts.${head.version}.`))).toBe(true);
  });

  it('keeps the old list whole when a write is cut short', async () => {
    const { values, storage } = memoryStorage();
    const book = storedContactBook(storage);
    for (let n = 1; n <= 20; n++) await book.put(contact(n));
    // The app is killed while the next version is being written: its pieces are there,
    // the head still points at the old one.
    let writes = 0;
    const dying: KeyValueStorage = {
      ...storage,
      set: async (key, value) => {
        if (++writes > 1) throw new Error('killed');
        values.set(key, value);
      },
    };
    await expect(storedContactBook(dying).put(contact(21))).rejects.toThrow('killed');
    expect((await storedContactBook(storage).list()).length).toBe(20);
  });

  it('says so, instead of showing an empty list, when a piece is missing', async () => {
    const { values, storage } = memoryStorage();
    await storedContactBook(storage).put(contact(1));
    values.delete('tc.contacts.1.0');
    await expect(storedContactBook(storage).list()).rejects.toThrow('incomplete');
  });

  it('applies changes made at the same moment one after the other', async () => {
    const book = storedContactBook(memoryStorage().storage);
    await Promise.all([1, 2, 3, 4, 5].map((n) => book.put(contact(n))));
    expect((await book.list()).map((c) => c.label)).toEqual(['BB', 'BB2', 'BB3', 'BB4', 'BB5']);
  });
});
