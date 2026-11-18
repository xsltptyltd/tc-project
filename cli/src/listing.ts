// How a contact list is printed: by name — the alias if there is one, the label
// otherwise — with the label kept visible next to an alias, then the device id.
//
//   BB                      w678UMh8nwaeHuht3D7oo4GMLGIBoe2VQZkGVW0ToZo
//   BB2                     7QVWJz7jqs4sesRYEV9NHo1XHEBHZFT6uLzT4YWgEK0
//   Coach        (BB3)      L6wpgVAZsiG9CKztOO380SmYRs9P7YR9ptFm2LU4SJg
import { byName, nameOf, type Contact } from 'tc-client';

const width = (text: string) => [...text].length;
const pad = (text: string, to: number) => text + ' '.repeat(Math.max(0, to - width(text)));

export function contactLines(contacts: Contact[]): string[] {
  const sorted = byName(contacts);
  const names = Math.max(0, ...sorted.map((c) => width(nameOf(c))));
  const labels = Math.max(0, ...sorted.map((c) => (c.alias ? width(c.label) + 2 : 0)));
  return sorted.map((c) => {
    const label = c.alias ? `(${c.label})` : '';
    return `${pad(nameOf(c), names)}  ${labels ? `${pad(label, labels)}  ` : ''}${c.deviceId}`;
  });
}
