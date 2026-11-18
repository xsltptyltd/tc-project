import { describe, expect, it } from 'vitest';
import { ProximityUnavailable } from 'tc-client';
import { roomProximity } from '../src/room';

const invitation = { inviter: 'A'.repeat(43), secret: 'S'.repeat(43) };

describe('the room, standing in for proximity', () => {
  it('gives the same value to the inviter and to an invitee in the same room', async () => {
    const announced = await roomProximity('1').announce(invitation);
    expect(announced.value).toBe(await roomProximity('1').sense(invitation));
    expect(announced.value).not.toBe(await roomProximity('2').sense(invitation));
  });

  it('ignores spaces around the room', async () => {
    expect(await roomProximity(' 1 ').sense(invitation)).toBe(await roomProximity('1').sense(invitation));
  });

  it.each([
    ['not set', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('cannot invite or accept when TC_ROOM is %s, and says how to fix it', async (_label, room) => {
    await expect(roomProximity(room).announce(invitation)).rejects.toThrow(ProximityUnavailable);
    await expect(roomProximity(room).sense(invitation)).rejects.toThrow(/set TC_ROOM to the same value on both sides/);
  });
});
