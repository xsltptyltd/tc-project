import { describe, expect, it } from 'vitest';
import type { Contact } from 'tc-client';
import { contactLines } from '../src/listing';

const id = (c: string) => c.repeat(43);
const contact = (label: string, deviceId: string, alias?: string): Contact => ({
  deviceId,
  initials: label.replace(/\d+$/, ''),
  label,
  ...(alias && { alias }),
});

describe('a printed contact list', () => {
  it('goes by name, shows the label beside an alias, and lines up', () => {
    const lines = contactLines([
      contact('BB2', id('b')),
      contact('BB3', id('c'), 'Tennis partner'),
      contact('BB', id('a')),
      contact('CD', id('d'), 'Sam'),
      contact('BB10', id('e')),
    ]);
    expect(lines).toEqual([
      `BB                     ${id('a')}`,
      `BB2                    ${id('b')}`,
      `BB10                   ${id('e')}`,
      `Sam             (CD)   ${id('d')}`,
      `Tennis partner  (BB3)  ${id('c')}`,
    ]);
  });

  it('has no label column when nobody has an alias', () => {
    expect(contactLines([contact('M', id('a')), contact('JPS', id('b'))])).toEqual([
      `JPS  ${id('b')}`,
      `M    ${id('a')}`,
    ]);
  });

  it('is empty for nobody', () => {
    expect(contactLines([])).toEqual([]);
  });
});
