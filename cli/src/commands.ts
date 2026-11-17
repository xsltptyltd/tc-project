// What a line typed in `cli chat` means.

/** Typed on its own, takes back everything not yet delivered to the person in this chat. */
export const DELETE_COMMAND = '> delete';

export type Line = { kind: 'skip' } | { kind: 'delete' } | { kind: 'send'; text: string };

export function parseLine(line: string): Line {
  if (!line.trim()) return { kind: 'skip' };
  if (line.trim() === DELETE_COMMAND) return { kind: 'delete' };
  return { kind: 'send', text: line };
}
