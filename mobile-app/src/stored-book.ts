// The phone's contact book (design/DECISIONS.md D20): the keys met in person, with their
// initials, labels and aliases, kept in a key-value storage — the platform's secure
// storage on the phone (./contact-book.ts), a Map in tests. It never leaves the device.
//
// Secure storage holds small values only (about 2 kB each), so the list is written as
// several pieces. A new version is written beside the old one and becomes the list when
// one small value, the head, is changed to point at it: a write cut short by the app
// being killed leaves the old list whole.
import type { Contact, ContactBook } from 'tc-client';

export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Characters per piece: under 2 kB even if every one of them takes four bytes. */
export const PIECE_CHARS = 500;

interface Head {
  version: number;
  pieces: number;
}

export function storedContactBook(storage: KeyValueStorage, prefix = 'tc.contacts'): ContactBook {
  const headKey = `${prefix}.head`;
  const pieceKey = (version: number, piece: number) => `${prefix}.${version}.${piece}`;

  let head: Head = { version: 0, pieces: 0 };
  let contacts: Contact[] | undefined;
  // One read or write at a time, in the order asked.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(step: () => Promise<T>): Promise<T> => {
    const result = queue.then(step);
    queue = result.catch(() => {});
    return result;
  };

  async function load(): Promise<Contact[]> {
    if (contacts) return contacts;
    const stored = await storage.get(headKey);
    if (stored) head = JSON.parse(stored) as Head;
    let json = '';
    for (let piece = 0; piece < head.pieces; piece++) {
      const part = await storage.get(pieceKey(head.version, piece));
      // Never an empty list by mistake: that would look like having no contacts.
      if (part === null) throw new Error('the contact list on this device is incomplete');
      json += part;
    }
    contacts = json ? (JSON.parse(json) as Contact[]) : [];
    return contacts;
  }

  async function save(next: Contact[]): Promise<void> {
    const json = JSON.stringify(next);
    // By code point, so a piece never ends in the middle of a character.
    const characters = [...json];
    const pieces: string[] = [];
    for (let at = 0; at < characters.length; at += PIECE_CHARS) {
      pieces.push(characters.slice(at, at + PIECE_CHARS).join(''));
    }
    const old = head;
    const fresh: Head = { version: old.version + 1, pieces: pieces.length };
    for (const [piece, part] of pieces.entries()) await storage.set(pieceKey(fresh.version, piece), part);
    await storage.set(headKey, JSON.stringify(fresh)); // from here on, this is the list
    head = fresh;
    contacts = next;
    for (let piece = 0; piece < old.pieces; piece++) await storage.delete(pieceKey(old.version, piece));
  }

  return {
    list: () => inTurn(async () => (await load()).map((c) => ({ ...c }))),
    get: (deviceId) =>
      inTurn(async () => {
        const found = (await load()).find((c) => c.deviceId === deviceId);
        return found && { ...found };
      }),
    put: (contact) =>
      inTurn(async () => {
        const all = await load();
        const at = all.findIndex((c) => c.deviceId === contact.deviceId);
        // Replaced in place: the list keeps the order contacts were added in.
        await save(at === -1 ? [...all, { ...contact }] : all.map((c, i) => (i === at ? { ...contact } : c)));
      }),
    remove: (deviceId) =>
      inTurn(async () => {
        const all = await load();
        if (all.some((c) => c.deviceId === deviceId)) await save(all.filter((c) => c.deviceId !== deviceId));
      }),
  };
}
