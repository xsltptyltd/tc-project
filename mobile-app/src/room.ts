// The phone's stand-in for Bluetooth proximity, until Bluetooth is built
// (design/DECISIONS.md D1, D18): two people are "side by side" when their devices are
// set to the same room. It is the same stand-in as the terminal's TC_ROOM
// (cli/src/room.ts), so a phone and a terminal in the same room can add each other.
//
// The room is mixed into the invitation's key on each side and never sent. Bluetooth
// will be another `Proximity`, passed to the same `invite` and `accept`.
import { ProximityUnavailable, type Proximity } from 'tc-client';

export function roomProximity(room: string): Proximity {
  const name = room.trim();
  const inRoom = (): string => {
    if (!name) throw new ProximityUnavailable('Set a room first: the same one on both devices.');
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
