// A local profile: ./.tc/<name>.json, unencrypted — fine for trying things out, not for
// real use. It holds the identity, once set the initials, and the contact book: the keys
// met in person (D20). On the phone the same things live in the platform's secure
// storage instead (mobile-app/src/identity.ts).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelFor, type Contact, type ContactBook } from 'tc-client';
import type { Identity } from 'tc-crypto';
import { InitialsSchema, type Initials } from 'tc-protocol';

export interface Profile extends Identity {
  /** The only name anyone else, and the backend, will see (D13). */
  initials?: Initials;
  /** The only keys this profile encrypts to and shows messages from (D20). */
  contacts?: Contact[];
  /** Made by `npm run simulation`, which may replace it when run again. */
  simulated?: boolean;
}

/**
 * Contacts saved before labels existed get theirs now, in the order they were added —
 * as they would have then.
 */
function withLabels(contacts: Array<Omit<Contact, 'label'> & { label?: string }>): Contact[] {
  const done: Contact[] = [];
  for (const contact of contacts) {
    const label = contact.label ?? labelFor(contact.initials, done.flatMap((c) => (c.alias ? [c.label, c.alias] : [c.label])));
    done.push({ ...contact, label });
  }
  return done;
}

/**
 * What the person typed, as initials: 1 to 4 letters A–Z, in either case, stored upper
 * case. Undefined for anything else.
 */
export function parseInitials(typed: string): Initials | undefined {
  const trimmed = typed.trim();
  if (!/^[A-Za-z]+$/.test(trimmed)) return undefined;
  const parsed = InitialsSchema.safeParse(trimmed.toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

export class Profiles {
  constructor(readonly dir: string) {}

  path(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  load(name: string): Profile {
    if (!this.exists(name)) throw new Error(`no identity "${name}" — run: cli init ${name}`);
    const profile = JSON.parse(readFileSync(this.path(name), 'utf8')) as Profile;
    return profile.contacts ? { ...profile, contacts: withLabels(profile.contacts) } : profile;
  }

  create(name: string, identity: Identity, extra: Pick<Profile, 'initials' | 'simulated'> = {}): void {
    if (this.exists(name)) throw new Error(`identity "${name}" already exists`);
    this.write(name, { ...identity, ...extra });
  }

  /** Deletes a profile: its keys, initials and contacts. */
  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  setInitials(name: string, initials: Initials): Profile {
    const profile = { ...this.load(name), initials };
    this.write(name, profile);
    return profile;
  }

  /** The profile's contact book, read from and written to its file each time. */
  contactBook(name: string): ContactBook {
    return {
      list: async () => this.load(name).contacts ?? [],
      get: async (deviceId) => this.load(name).contacts?.find((c) => c.deviceId === deviceId),
      put: async (contact) => {
        const profile = this.load(name);
        const contacts = profile.contacts ?? [];
        const at = contacts.findIndex((c) => c.deviceId === contact.deviceId);
        // Replaced in place: the file keeps the order contacts were added in.
        const next = at === -1 ? [...contacts, contact] : contacts.map((c, i) => (i === at ? contact : c));
        this.write(name, { ...profile, contacts: next });
      },
      remove: async (deviceId) => {
        const profile = this.load(name);
        this.write(name, { ...profile, contacts: (profile.contacts ?? []).filter((c) => c.deviceId !== deviceId) });
      },
    };
  }

  private write(name: string, profile: Profile): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(name), JSON.stringify(profile, null, 2), { mode: 0o600 });
  }
}
