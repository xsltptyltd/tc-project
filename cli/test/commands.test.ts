import { describe, expect, it } from 'vitest';
import { parseLine } from '../src/commands';

describe('a line typed in the chat', () => {
  it('"> delete" takes back what was not delivered', () => {
    expect(parseLine('> delete')).toEqual({ kind: 'delete' });
    expect(parseLine('  > delete  ')).toEqual({ kind: 'delete' });
  });

  it.each(['>delete', '> delete please', '> DELETE', 'delete', 'please > delete'])(
    '%j is an ordinary message',
    (line) => {
      expect(parseLine(line)).toEqual({ kind: 'send', text: line });
    },
  );

  it('is sent as typed', () => {
    expect(parseLine('  see you at 8 ')).toEqual({ kind: 'send', text: '  see you at 8 ' });
  });

  it('is skipped when blank', () => {
    expect(parseLine('   ')).toEqual({ kind: 'skip' });
  });
});
