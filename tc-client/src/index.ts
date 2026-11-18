// One device's connection to the backend: connect, send, receive.
// Uses the standard WebSocket interface, which exists in Node 22+, in browsers and in
// React Native, so the command-line client and the phone app share this code.
import {
  createAuthToken,
  decryptFrom,
  encryptFor,
  invitationKey,
  invitationMac,
  invitationTokenId,
  newInvitationSecret,
  verifyInvitationMac,
  type Identity,
} from 'tc-crypto';
import {
  InitialsSchema,
  type ClientAction,
  type DeviceId,
  type ErrorCode,
  type Initials,
  type ServerEvent,
} from 'tc-protocol';
import { ContactList, MemoryContactBook, nameOf, NotAContact, type Contact, type ContactBook } from './contacts';
import type { Invitation, OpenInvitation } from './invitation';
import type { Announcement, Proximity } from './proximity';

export * from './contacts';
export * from './invitation';
export * from './proximity';

export interface IncomingMessage {
  id: string;
  /** Always a contact: messages from anyone else are never shown (D20). */
  from: DeviceId;
  /** What this device calls the sender: its alias, or its label (D13). */
  name: string;
  text: string;
}

/** Confirms the backend accepted a message. It says nothing about the receiver. */
export interface SendReceipt {
  messageId: string;
}

export class ServerError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`server error: ${code}`);
  }
}

/**
 * How many message ids a client remembers, to show each message once. Far more than can
 * arrive twice in practice: a repeat comes within one connection or on the next.
 */
export const REMEMBERED_IDS = 1000;

/** How long a request waits for its answer before it is given up. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * What a sync did. `refused`: the backend's list had none of this device's contacts, and
 * there were several — nothing was dropped, because one wrong answer must not empty a
 * list that only meeting again can rebuild (D21).
 */
export type SyncOutcome = 'synced' | 'refused';

/** Events that answer one frame this client sent. */
type Reply = Extract<ServerEvent, { type: 'sent' | 'invited' | 'accepted' | 'removed' | 'contacts' }>;

/** Call `init()` from tc-crypto before using this. */
export class TcClient {
  private socket?: WebSocket;
  // Requests waiting for their answer. An answer goes to the oldest request expecting
  // that kind of answer: the backend may answer two frames in either order (on AWS each
  // frame is handled on its own), so the order sent is not relied on across kinds.
  private pending: Array<{
    expects: Reply['type'];
    resolve(reply: Reply): void;
    reject(error: Error): void;
  }> = [];
  // Answers still owed to requests that were given up: ignored if they ever come.
  private abandoned = new Map<Reply['type'], number>();
  // Inviters whose invitation this device is accepting right now: the backend may list
  // them before this device has added them.
  private accepting = new Set<DeviceId>();
  private messageListeners: Array<(message: IncomingMessage) => void> = [];
  private inviteeListeners: Array<(invitee: Contact) => void> = [];
  private readonly contacts: ContactList;
  private forgedInviteeListeners: Array<() => void> = [];
  private contactRemovedListeners: Array<(deviceId: DeviceId) => void> = [];
  // Contacts added while a sync is waiting for its answer: the answer may predate them,
  // and must not make this device drop them.
  private syncs = 0;
  private addedDuringSync = new Set<DeviceId>();
  // Events are handled one at a time, in the order they came: looking up the contact
  // book takes a moment, and a message must not be checked before the acceptance that
  // added its sender has been.
  private events: Promise<void> = Promise.resolve();
  // The keys of invitations this client is showing, by token id, until they are
  // accepted, closed or expire; and what is being announced for each. Only here, in
  // memory: never sent, never stored.
  private openInvitations = new Map<string, { key: string; forgetAt: number; announcement: Announcement }>();
  private closeListeners: Array<() => void> = [];
  // A message sent while we are connecting can arrive twice: live, and in the answer
  // to `fetch`. Listeners see each message once. Only the most recent ids are kept, so
  // this does not grow for as long as the app runs.
  private delivered = new Set<string>();
  // Ids acknowledged on the current connection. A message that comes again on a later
  // connection was not deleted — the acknowledgement was lost — so it is acknowledged again.
  private acknowledged = new Set<string>();

  /**
   * @param contacts who this device trusts: the only keys it encrypts to and shows
   *   messages from, filled only by exchanges in person (D20). The default is empty and
   *   forgotten with this object.
   */
  constructor(
    private readonly identity: Identity,
    private readonly url: string,
    contacts: ContactBook = new MemoryContactBook(),
  ) {
    this.contacts = new ContactList(contacts);
  }

  get connected(): boolean {
    return this.socket?.readyState === 1; // WebSocket.OPEN
  }

  /** Rejects if the server is unreachable or refuses the connection. */
  connect(): Promise<void> {
    const token = createAuthToken(this.identity, Math.floor(Date.now() / 1000));
    const socket = new WebSocket(`${this.url.replace(/\/+$/, '')}/?auth=${token}`);
    this.socket = socket;
    this.acknowledged.clear();
    return new Promise((resolve, reject) => {
      let opened = false;
      socket.onopen = () => {
        opened = true;
        // Ask for whatever arrived while this device was offline.
        socket.send(JSON.stringify({ action: 'fetch' } satisfies ClientAction));
        resolve();
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const parsed = JSON.parse(event.data) as ServerEvent;
        // A failure handling one event (say, the contact book cannot be written) must not
        // stop the ones after it.
        this.events = this.events.then(() => this.handle(parsed)).catch(() => {});
      };
      socket.onerror = () => {
        if (!opened) reject(new Error('could not connect'));
      };
      socket.onclose = () => {
        if (!opened) reject(new Error('could not connect'));
        for (const waiting of this.pending.splice(0)) waiting.reject(new Error('connection closed'));
        if (opened) for (const listener of this.closeListeners) listener();
      };
    });
  }

  onMessage(listener: (message: IncomingMessage) => void): void {
    this.messageListeners.push(listener);
  }

  /** Called when an established connection ends, whoever ended it. */
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Encrypts for `to` and sends. Only to a contact in this device's contact book: anyone
   * else is refused with `NotAContact` before anything is encrypted or sent (D20). The
   * backend refuses non-contacts too (`ServerError('not_a_contact')`, D19), but this
   * check does not depend on the backend being honest.
   */
  async send(to: DeviceId, text: string): Promise<SendReceipt> {
    if (!(await this.contacts.get(to))) throw new NotAContact(to);
    const action: ClientAction = {
      action: 'send',
      to,
      ciphertext: encryptFor(this.identity, to, { v: 1, text }),
    };
    const reply = await this.request(action, 'sent');
    return { messageId: reply.messageId };
  }

  /**
   * Starts an invitation (D1, D18): makes a one-time secret, starts announcing a
   * proximity value, and registers with the backend the hash of the key made of the two,
   * together with this device's initials. Show the returned invitation to the person
   * being invited — through an `InvitationCodec` — for `expiresIn` seconds. Whoever
   * accepts it, from beside this device, is added to the contact book and reported to
   * `onInvitee`, once — but only if its MAC proves it held the invitation key. One whose
   * MAC does not match is reported to `onForgedInvitee` and never added (D20).
   *
   * Rejects with `ProximityUnavailable`, having sent nothing, if proximity cannot be
   * announced.
   */
  async invite(initials: Initials, proximity: Proximity): Promise<OpenInvitation> {
    InitialsSchema.parse(initials);
    const invitation: Invitation = { inviter: this.identity.deviceId, secret: newInvitationSecret() };
    const announcement = await proximity.announce(invitation);
    const key = invitationKey(invitation.secret, announcement.value);
    const tokenId = invitationTokenId(key);
    this.forgetExpiredInvitations();
    // Known before the frame goes, so an acceptance can never arrive ahead of it.
    const open = { key, forgetAt: Infinity, announcement };
    this.openInvitations.set(tokenId, open);
    try {
      const reply = await this.request({ action: 'invite', tokenId, initials }, 'invited');
      open.forgetAt = Date.now() + reply.expiresIn * 1000;
      return { invitation, expiresIn: reply.expiresIn, close: () => this.closeInvitation(tokenId) };
    } catch (error) {
      this.closeInvitation(tokenId);
      throw error;
    }
  }

  /**
   * Called when someone accepts one of this device's invitations. They are a contact now:
   * the listener gets them as the contact list has them, label included.
   */
  onInvitee(listener: (invitee: Contact) => void): void {
    this.inviteeListeners.push(listener);
  }

  /**
   * Called when the backend reports an acceptance of one of this device's open
   * invitations whose MAC does not match: a key the invitee did not seal with the
   * invitation key. Only a backend that is not honest — or a bug — can cause this. The
   * key is not added; the invitation stays open until it is accepted or expires.
   */
  onForgedInvitee(listener: () => void): void {
    this.forgedInviteeListeners.push(listener);
  }

  /**
   * Accepts an invitation read from the inviter's screen, from beside the inviter,
   * giving this device's initials. On success the two are contacts, and the inviter's
   * key — as read from the code, not from the backend — is added to the contact book.
   *
   * Rejects with `ProximityUnavailable`, having sent nothing, if proximity cannot be
   * sensed. Rejects with `ServerError('invitation_invalid')` if the backend has no such
   * invitation for the key — unknown, expired, already accepted, or read somewhere else
   * than beside the inviter: nobody can tell which.
   */
  async accept(invitation: Invitation, initials: Initials, proximity: Proximity): Promise<Contact> {
    InitialsSchema.parse(initials);
    if (invitation.inviter === this.identity.deviceId) throw new Error('that is your own invitation');
    const key = invitationKey(invitation.secret, await proximity.sense(invitation));
    this.accepting.add(invitation.inviter);
    try {
      const reply = await this.request(
        {
          action: 'accept',
          tokenId: invitationTokenId(key),
          inviter: invitation.inviter,
          initials,
          mac: invitationMac(key, invitation.inviter, this.identity.deviceId, initials),
        },
        'accepted',
      );
      // The key comes from the code we read, never from the backend.
      if (reply.inviter !== invitation.inviter) throw new Error('the backend answered for someone else');
      return await this.addContact({ deviceId: invitation.inviter, initials: reply.initials });
    } finally {
      this.accepting.delete(invitation.inviter);
    }
  }

  /**
   * Ends the contact with `deviceId`, for both sides (D5, D21): the backend deletes it and
   * every message still waiting between the two, and tells the other device, which drops
   * this one from its list without a word to its owner. Then this device forgets it.
   */
  async removeContact(deviceId: DeviceId): Promise<void> {
    await this.request({ action: 'remove', contact: deviceId }, 'removed');
    await this.forget(deviceId);
  }

  /**
   * Brings this device's list and the backend's in line (D21). Call it after connecting;
   * apps do when they are opened.
   *
   * - Drops every contact the backend no longer has — removed by the other side while
   *   this device was offline. Unless that would drop all of several contacts at once:
   *   then nothing is dropped and the outcome is `refused`.
   * - Never adds one: a key gets into the list only in person (D20). A contact the
   *   backend has and this device does not — an acceptance this device never saw or
   *   never believed — is ended on the backend, so that neither side has half a contact.
   */
  async syncContacts(): Promise<SyncOutcome> {
    if (this.syncs++ === 0) this.addedDuringSync.clear();
    try {
      const reply = await this.request({ action: 'contacts' }, 'contacts');
      const known = new Set(reply.contacts);
      const mine = (await this.contacts.list()).filter((c) => !this.addedDuringSync.has(c.deviceId));
      const gone = mine.filter((c) => !known.has(c.deviceId));
      const refused = gone.length > 1 && gone.length === mine.length;
      if (!refused) for (const contact of gone) await this.forget(contact.deviceId);

      // Not while an invitation of ours is open, or being accepted by us: the backend may
      // know of that contact a moment before this device does.
      this.forgetExpiredInvitations();
      if (this.openInvitations.size === 0) {
        for (const deviceId of reply.contacts) {
          if (this.accepting.has(deviceId) || (await this.contacts.get(deviceId))) continue;
          await this.request({ action: 'remove', contact: deviceId }, 'removed');
        }
      }
      return refused ? 'refused' : 'synced';
    } finally {
      this.syncs--;
    }
  }

  /**
   * Called when a contact is dropped from this device's list by the other side, or by
   * another device of this person. Not something to announce to the person (D5): it is
   * for keeping what is on screen up to date.
   */
  onContactRemoved(listener: (deviceId: DeviceId) => void): void {
    this.contactRemovedListeners.push(listener);
  }

  /**
   * Takes back what this device sent to `to` and has not been delivered yet: the one
   * message `messageId`, or all of them. The backend does not answer, so there is no way
   * to know what was deleted — by design: that would say whether the receiver got it.
   */
  unsend(to: DeviceId, messageId?: string): void {
    if (!this.socket || !this.connected) throw new Error('not connected');
    const action: ClientAction = { action: 'unsend', to, ...(messageId !== undefined && { messageId }) };
    this.socket.send(JSON.stringify(action));
  }

  close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === 3) return Promise.resolve(); // WebSocket.CLOSED
    return new Promise((resolve) => {
      this.closeListeners.push(resolve);
      socket.close();
    });
  }

  /**
   * Sends a frame and waits for the reply of type `expects` (or an error). Rejects if no
   * answer has come after REQUEST_TIMEOUT_MS.
   */
  private request<T extends Reply['type']>(action: ClientAction, expects: T): Promise<Extract<Reply, { type: T }>> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('not connected'));
        return;
      }
      const waiting = {
        expects,
        resolve: (reply: Reply) => {
          clearTimeout(timer);
          resolve(reply as Extract<Reply, { type: T }>);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const at = this.pending.indexOf(waiting);
        if (at === -1) return;
        this.pending.splice(at, 1);
        this.abandoned.set(expects, (this.abandoned.get(expects) ?? 0) + 1);
        reject(new Error('no answer from the server'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.push(waiting);
      this.socket.send(JSON.stringify(action));
    });
  }

  private reply(event: Reply): void {
    const at = this.pending.findIndex((waiting) => waiting.expects === event.type);
    if (at !== -1) {
      this.pending.splice(at, 1)[0]!.resolve(event);
      return;
    }
    // The late answer to a request that was given up.
    const owed = this.abandoned.get(event.type) ?? 0;
    if (owed > 0) {
      this.abandoned.set(event.type, owed - 1);
      return;
    }
    // Nobody asked for this: whoever is first in line was answered wrongly.
    const first = this.pending.shift();
    first?.reject(new Error(`expected ${first.expects}, got ${event.type}`));
  }

  /**
   * An error answers the oldest request it can be about: `not_a_contact` a send,
   * `invitation_invalid` an invite or an accept, anything else whichever is first.
   */
  private fail(code: ErrorCode): void {
    const about: Partial<Record<ErrorCode, Array<Reply['type']>>> = {
      not_a_contact: ['sent'],
      invitation_invalid: ['invited', 'accepted'],
    };
    const kinds = about[code];
    const at = kinds ? this.pending.findIndex((waiting) => kinds.includes(waiting.expects)) : -1;
    const [waiting] = this.pending.splice(Math.max(at, 0), 1);
    waiting?.reject(new ServerError(code));
  }

  private async addContact(met: { deviceId: DeviceId; initials: Initials }): Promise<Contact> {
    if (this.syncs > 0) this.addedDuringSync.add(met.deviceId);
    return this.contacts.addMet(met);
  }

  /** Drops a contact from the list, telling the listeners if it was there. */
  private async forget(deviceId: DeviceId): Promise<void> {
    if (!(await this.contacts.remove(deviceId))) return; // already gone: nothing to tell
    for (const listener of this.contactRemovedListeners) listener(deviceId);
  }

  private closeInvitation(tokenId: string): void {
    this.openInvitations.get(tokenId)?.announcement.stop();
    this.openInvitations.delete(tokenId);
  }

  private forgetExpiredInvitations(): void {
    const now = Date.now();
    for (const [tokenId, open] of this.openInvitations) {
      if (open.forgetAt <= now) this.closeInvitation(tokenId);
    }
  }

  /** Believed only if the MAC shows it was made with the key of one of our invitations. */
  private async handleInvitee(event: Extract<ServerEvent, { type: 'invitee' }>): Promise<void> {
    this.forgetExpiredInvitations();
    const open = this.openInvitations.get(event.tokenId);
    if (!open) return; // not one of ours, or no longer open
    const proven =
      InitialsSchema.safeParse(event.initials).success &&
      verifyInvitationMac(open.key, this.identity.deviceId, event.invitee, event.initials, event.mac);
    if (!proven) {
      // Not sealed with our key: the backend, or someone, swapped the key or the initials.
      for (const listener of this.forgedInviteeListeners) listener();
      return;
    }
    // The only way an invitee's key gets in.
    const invitee = await this.addContact({ deviceId: event.invitee, initials: event.initials });
    this.closeInvitation(event.tokenId); // one use
    for (const listener of this.inviteeListeners) listener(invitee);
  }

  /** Once per connection for each message; a repeat within one connection is not needed. */
  private acknowledge(id: string): void {
    if (!this.connected || this.acknowledged.has(id)) return;
    this.acknowledged.add(id);
    this.socket?.send(JSON.stringify({ action: 'ack', messageId: id } satisfies ClientAction));
  }

  private remember(id: string): void {
    this.delivered.add(id);
    if (this.delivered.size > REMEMBERED_IDS) {
      // A Set keeps insertion order, so the first one is the oldest.
      this.delivered.delete(this.delivered.values().next().value!);
    }
  }

  private async handle(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case 'message': {
        const { id, from, ciphertext } = event.envelope;
        if (this.delivered.has(id)) {
          this.acknowledge(id); // shown already; make sure the backend lets go of it
          return;
        }
        // Only from a contact (D20): whatever key the backend claims a message is from,
        // it is shown only if this device met that key in person. Not acknowledged
        // either, so if it is a contact being added at this very moment, the message
        // comes again on the next fetch.
        const sender = await this.contacts.get(from);
        if (!sender) return;
        let text: string;
        try {
          text = decryptFrom(this.identity, from, ciphertext).text;
        } catch {
          return; // not for us, or not from who it claims: drop it
        }
        if (this.messageListeners.length === 0) return; // nobody to give it to: keep it
        this.remember(id);
        for (const listener of this.messageListeners) listener({ id, from, name: nameOf(sender), text });
        // The app has it now, so the backend deletes it (D9): from here on it exists only
        // in this app's memory. If the connection is already gone, it comes again next time.
        this.acknowledge(id);
        return;
      }
      case 'sent':
      case 'invited':
      case 'accepted':
      case 'removed':
      case 'contacts':
        this.reply(event);
        return;
      case 'contact_removed':
        // Only ever removes: whatever the backend says, it cannot add a key this way.
        await this.forget(event.contact);
        return;
      case 'invitee':
        await this.handleInvitee(event);
        return;
      case 'error':
        this.fail(event.code);
        return;
    }
  }
}
