// The people this device trusts, and the only keys it ever encrypts to
// (design/DECISIONS.md D20), and what this device calls them (D13).
//
// A key gets here only from an exchange made in person: the inviter's key read from its
// code, or the invitee's key once its MAC has been checked (D18). Never from the backend
// alone, never from a device id someone typed. That is what keeps a corrupted backend out
// of the middle: it can hand this device any key it likes, but it cannot get that key
// into this list, so nothing is ever encrypted to it and nothing it sends is shown.
//
// Names, from least to most personal (D13):
//   initials  what the person gave: `BB`. Not unique.
//   label     fixed when the contact is added: the initials, or the initials and the
//             lowest free number if this list already has that name: `BB2`, `BB3`…
//   alias     anything the owner of this device chooses, instead of the label: `Sam`.
// A contact is shown by its alias if it has one, by its label otherwise. Labels and
// aliases never leave the device, and no two contacts in one list are shown the same.
//
// Where the list is kept depends on the app, so storage sits behind `ContactBook`:
//   terminal  the profile file, .tc/<name>.json (cli/src/profile.ts)
//   phone     (not built) the platform's secure storage, like the identity
//   tests     `MemoryContactBook`
// The rules above are in `ContactList`, the same for all of them.
import type { DeviceId, Initials } from 'tc-protocol';

/** Someone met in person, whose key this device checked itself. */
export interface Contact {
  deviceId: DeviceId;
  /** As they gave them when met. */
  initials: Initials;
  /** Unique in this list, fixed when added: the initials, maybe followed by a number. */
  label: string;
  /** Chosen by the owner of this device; shown instead of the label. */
  alias?: string;
}

/** Just storage: it keeps what it is given. The rules are in `ContactList`. */
export interface ContactBook {
  list(): Promise<Contact[]>;
  get(deviceId: DeviceId): Promise<Contact | undefined>;
  /** Adds, or replaces the contact with the same device id. */
  put(contact: Contact): Promise<void>;
  /** Forgets the contact: key, label, alias — nothing is kept. */
  remove(deviceId: DeviceId): Promise<void>;
}

/** Refused on this device: `to` is not in its contact book, so nothing was encrypted. */
export class NotAContact extends Error {
  override name = 'NotAContact';
  constructor(readonly deviceId: DeviceId) {
    super('not one of your contacts');
  }
}

/** An alias that cannot be used: empty, too long, or already the name of another contact. */
export class AliasRefused extends Error {
  override name = 'AliasRefused';
}

export const ALIAS_MAX_LENGTH = 32;

/** How this device shows a contact: its alias, or its label. */
export const nameOf = (contact: Contact): string => contact.alias ?? contact.label;

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * The label for someone with `initials`, given the names already in use in this list:
 * the initials if free, otherwise the initials followed by the lowest free number from 2.
 */
export function labelFor(initials: Initials, namesInUse: Iterable<string>): string {
  const taken = [...namesInUse];
  const free = (name: string) => !taken.some((t) => same(t, name));
  if (free(initials)) return initials;
  for (let n = 2; ; n++) if (free(`${initials}${n}`)) return `${initials}${n}`;
}

/** All the names a list uses: every label, and every alias. */
const namesIn = (contacts: Contact[]) => contacts.flatMap((c) => (c.alias ? [c.label, c.alias] : [c.label]));

/** Sorted by name, numbers in order: BB, BB2, BB10, Sam. */
export function byName(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }),
  );
}

/** The contacts of one device, with the rules for labels and aliases. */
export class ContactList {
  // One change at a time: each one reads the list and writes it back, and two labels
  // computed side by side could otherwise be the same.
  private changes: Promise<unknown> = Promise.resolve();

  constructor(private readonly book: ContactBook) {}

  list(): Promise<Contact[]> {
    return this.book.list();
  }

  get(deviceId: DeviceId): Promise<Contact | undefined> {
    return this.book.get(deviceId);
  }

  /**
   * Someone met in person. A new contact gets its label now, for good. Someone already
   * in the list is left exactly as they are — same label, same alias (D5).
   */
  addMet(met: { deviceId: DeviceId; initials: Initials }): Promise<Contact> {
    return this.change(async () => {
      const existing = await this.book.get(met.deviceId);
      if (existing) return existing;
      const contact = { deviceId: met.deviceId, initials: met.initials, label: labelFor(met.initials, namesIn(await this.book.list())) };
      await this.book.put(contact);
      return contact;
    });
  }

  /**
   * Gives `deviceId` an alias, or takes it away (`undefined`). Refused with `AliasRefused`
   * if it is blank, longer than ALIAS_MAX_LENGTH, or already the label or alias of another
   * contact (ignoring case): no two contacts are shown the same.
   */
  setAlias(deviceId: DeviceId, alias: string | undefined): Promise<Contact> {
    return this.change(async () => {
      const contacts = await this.book.list();
      const contact = contacts.find((c) => c.deviceId === deviceId);
      if (!contact) throw new NotAContact(deviceId);
      const { alias: _old, ...rest } = contact;
      if (alias === undefined) {
        await this.book.put(rest);
        return rest;
      }
      const trimmed = alias.trim();
      if (!trimmed) throw new AliasRefused('an alias cannot be blank');
      if ([...trimmed].length > ALIAS_MAX_LENGTH) throw new AliasRefused(`an alias is at most ${ALIAS_MAX_LENGTH} characters`);
      if (/\p{Cc}/u.test(trimmed)) throw new AliasRefused('an alias cannot contain control characters');
      const others = namesIn(contacts.filter((c) => c.deviceId !== deviceId));
      const clash = others.find((name) => same(name, trimmed));
      if (clash) throw new AliasRefused(`"${clash}" is already the name of another contact`);
      const updated = { ...rest, alias: trimmed };
      await this.book.put(updated);
      return updated;
    });
  }

  /**
   * Forgets a contact entirely. Its label becomes free for someone met later; no other
   * contact's label changes (D13). Resolves whether it was there.
   */
  remove(deviceId: DeviceId): Promise<boolean> {
    return this.change(async () => {
      if (!(await this.book.get(deviceId))) return false;
      await this.book.remove(deviceId);
      return true;
    });
  }

  /**
   * The contact someone means by `name`: its alias, its label (either ignoring case), or
   * its device id. Undefined if none.
   */
  async find(name: string): Promise<Contact | undefined> {
    const wanted = name.trim();
    const contacts = await this.book.list();
    return (
      contacts.find((c) => c.deviceId === wanted) ??
      contacts.find((c) => c.alias !== undefined && same(c.alias, wanted)) ??
      contacts.find((c) => same(c.label, wanted))
    );
  }

  private change<T>(step: () => Promise<T>): Promise<T> {
    const result = this.changes.then(step);
    this.changes = result.catch(() => {});
    return result;
  }
}

/** A contact book that lives as long as the object. */
export class MemoryContactBook implements ContactBook {
  readonly contacts = new Map<DeviceId, Contact>();

  async list(): Promise<Contact[]> {
    return [...this.contacts.values()].map((c) => ({ ...c }));
  }

  async get(deviceId: DeviceId): Promise<Contact | undefined> {
    const contact = this.contacts.get(deviceId);
    return contact && { ...contact };
  }

  async put(contact: Contact): Promise<void> {
    this.contacts.set(contact.deviceId, { ...contact });
  }

  async remove(deviceId: DeviceId): Promise<void> {
    this.contacts.delete(deviceId);
  }
}
