// The terminal's stand-in for Bluetooth proximity (design/DECISIONS.md D1, D18): two
// people are "side by side" when they set the same room, TC_ROOM. The room is mixed into
// the invitation's key on each side and never sent — not to the backend, not in the code.
//
// A stand-in only: anyone who knows or guesses the room name counts as nearby. On the
// phone, the same `Proximity` interface will be Bluetooth.
import { ProximityUnavailable, type Proximity } from 'tc-client';

export const ROOM_VARIABLE = 'TC_ROOM';

/** Proximity by room: `room` is the value of TC_ROOM; unset or blank means no room. */
export function roomProximity(room: string | undefined): Proximity {
  const name = room?.trim();
  const inRoom = (): string => {
    if (!name) {
      throw new ProximityUnavailable(
        `you are not in a room: set ${ROOM_VARIABLE} to the same value on both sides, ` +
          `for example ${ROOM_VARIABLE}=1 (it stands in for the phones being side by side)`,
      );
    }
    return name;
  };
  return {
    async announce() {
      return { value: inRoom(), stop() {} };
    },
    async sense() {
      return inRoom();
    },
  };
}
