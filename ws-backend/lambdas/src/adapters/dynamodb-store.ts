// The Store on DynamoDB — the single table from infra/dynamodb. The layout, and why no
// index is needed, is design/DECISIONS.md D16:
//
//   connection, by id       PK CONNECTION#<connectionId>   SK CONNECTION
//   connection, by device   PK DEVICE#<deviceId>           SK CONNECTION#<connectionId>
//   message                 PK DEVICE#<to>                 SK MSG#<id>
//                           + `delivered: true` once handed to the receiver (D17)
//   contact                 PK DEVICE#<owner>              SK CONTACT#<other>
//                           one per side, written and deleted in pairs (D5)
//   invitation              PK INVITATION#<tokenId>        SK INVITATION
//                           + `acceptedBy` once accepted; `ttl` = its expiry (D18)
//
// Tested without AWS: the item shaping directly, and the whole class through an
// in-memory stand-in for the DynamoDB client (test/fake-dynamodb.ts), with the same
// tests as the in-memory store (test/store-contract.test.ts). Never run on AWS yet.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { DeviceId, Envelope } from 'tc-protocol';
import type { Connection, ContactStore, InvitationRecord, Store } from '../core/ports';

const DEVICE = (deviceId: DeviceId) => `DEVICE#${deviceId}`;
const CONNECTION = (connectionId: string) => `CONNECTION#${connectionId}`;

/**
 * API Gateway closes every websocket within 2 hours, so a connection item older than
 * this is a leftover whose $disconnect was lost; the table's TTL sweeps it away.
 * Sending to it fails before that, which also deletes it.
 */
export const CONNECTION_SWEEP_SECONDS = 3 * 60 * 60;

export function connectionKey(connectionId: string) {
  return { PK: CONNECTION(connectionId), SK: 'CONNECTION' };
}

/** The same connection, filed under its device: "every connection this device has". */
export function deviceConnectionKey(deviceId: DeviceId, connectionId: string) {
  return { PK: DEVICE(deviceId), SK: CONNECTION(connectionId) };
}

const connectionFields = (connection: Connection) => ({
  ...connection,
  ttl: connection.connectedAt + CONNECTION_SWEEP_SECONDS,
});

/**
 * A connection is stored twice, both on the base table, because both directions must be
 * read with strong consistency: by connection id (the first frame can arrive right after
 * $connect), and by device (a message sent right after the receiver connected must find
 * that connection, or it would wait for the receiver's next fetch — D15, D16).
 */
export function connectionItem(connection: Connection) {
  return { ...connectionKey(connection.connectionId), ...connectionFields(connection) };
}

export function deviceConnectionItem(connection: Connection) {
  return {
    ...deviceConnectionKey(connection.deviceId, connection.connectionId),
    ...connectionFields(connection),
  };
}

export function connectionFrom(item: Record<string, unknown>): Connection {
  const { connectionId, deviceId, connectedAt } = item as ReturnType<typeof connectionItem>;
  return { connectionId, deviceId, connectedAt };
}

/**
 * Partitioned by receiver, keyed by id: an acknowledgement names the id and comes from
 * the receiver, so it is one exact delete — and can only reach the acker's own messages.
 */
export function messageKey(to: DeviceId, messageId: string) {
  return { PK: DEVICE(to), SK: `MSG#${messageId}` };
}

export function messageItem(envelope: Envelope) {
  return {
    ...messageKey(envelope.to, envelope.id),
    ...envelope,
    // DynamoDB deletes it some time after it expires; reads never rely on that (D8).
    ttl: envelope.expiresAt,
  };
}

export function envelopeFrom(item: Record<string, unknown>): Envelope {
  const { id, from, to, ciphertext, sentAt, expiresAt } = item as ReturnType<typeof messageItem>;
  return { id, from, to, ciphertext, sentAt, expiresAt };
}

/**
 * The sort key orders messages by id, not by time, so they are put in order here. That
 * costs nothing: listMessages reads the receiver's whole partition anyway.
 */
export function envelopesOldestFirst(items: Record<string, unknown>[]): Envelope[] {
  return items.map(envelopeFrom).sort((a, b) => a.sentAt - b.sentAt);
}

/**
 * One side of a contact, in the owner's partition: "every contact this device has" is one
 * query there, and "is X a contact of mine" one read.
 */
export function contactKey(owner: DeviceId, other: DeviceId) {
  return { PK: DEVICE(owner), SK: `CONTACT#${other}` };
}

/** A contact is two of these, one per side (D5). Nothing else: names live on devices (D13). */
export function contactItem(owner: DeviceId, other: DeviceId) {
  return { ...contactKey(owner, other), owner, contact: other };
}

export function invitationKey(tokenId: string) {
  return { PK: `INVITATION#${tokenId}`, SK: 'INVITATION' };
}

export function invitationItem(invitation: InvitationRecord) {
  return {
    ...invitationKey(invitation.tokenId),
    ...invitation,
    // DynamoDB deletes it some time after it expires; accepting checks expiry itself (D8).
    ttl: invitation.expiresAt,
  };
}

export function invitationFrom(item: Record<string, unknown>): InvitationRecord {
  const { tokenId, inviter, initials, expiresAt, acceptedBy } = item as ReturnType<typeof invitationItem>;
  return { tokenId, inviter, initials, expiresAt, ...(acceptedBy !== undefined && { acceptedBy }) };
}

/** The part of the DynamoDB document client the store uses; tests pass a stand-in. */
export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

export class DynamoStore implements Store, ContactStore {
  constructor(
    private readonly table: string,
    private readonly db: DocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ) {}

  async putConnection(connection: Connection): Promise<void> {
    // Both items or neither: half a connection would either never receive or never be removed.
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: connectionItem(connection) } },
          { Put: { TableName: this.table, Item: deviceConnectionItem(connection) } },
        ],
      }),
    );
  }

  async deleteConnection(connectionId: string): Promise<void> {
    // A $disconnect event carries only the connection id; the device is read from it.
    const connection = await this.getConnection(connectionId);
    if (!connection) return;
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: connectionKey(connectionId) } },
          { Delete: { TableName: this.table, Key: deviceConnectionKey(connection.deviceId, connectionId) } },
        ],
      }),
    );
  }

  async getConnection(connectionId: string): Promise<Connection | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: connectionKey(connectionId),
        // The first frame often arrives right after $connect wrote this item; an
        // eventually consistent read could still miss it and refuse the connection.
        ConsistentRead: true,
      }),
    );
    return Item && connectionFrom(Item);
  }

  async listConnections(deviceId: DeviceId): Promise<Connection[]> {
    // Strongly consistent, and that matters: a message is stored before this is read, and
    // a device fetches after its connection is written. So either this read sees the
    // connection and the message is pushed, or the connection came later and its fetch
    // sees the message. An index could not promise that (it is eventually consistent).
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'PK = :device AND begins_with(SK, :connection)',
      ExpressionAttributeValues: { ':device': DEVICE(deviceId), ':connection': 'CONNECTION#' },
      ConsistentRead: true,
    });
    return items.map(connectionFrom);
  }

  async putMessage(envelope: Envelope): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: messageItem(envelope) }));
  }

  async listMessages(deviceId: DeviceId, now: number): Promise<Envelope[]> {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'PK = :device AND begins_with(SK, :message)',
      // Expiry is enforced on read, because TTL deletion can lag by days (D8).
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: { ':device': DEVICE(deviceId), ':message': 'MSG#', ':now': now },
      // Strongly consistent, so a fetch sees a message written a moment before it.
      ConsistentRead: true,
    });
    return envelopesOldestFirst(items);
  }

  async deleteMessage(deviceId: DeviceId, messageId: string): Promise<void> {
    // Deleting a key that does not exist is a no-op, which is what an unknown or
    // repeated acknowledgement should be.
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: messageKey(deviceId, messageId) }));
  }

  async markDelivered(to: DeviceId, messageId: string): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: messageKey(to, messageId),
          UpdateExpression: 'SET delivered = :true',
          // Only if it still exists: a taken-back message must not come back to life.
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':true': true },
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async unsendMessages(from: DeviceId, to: DeviceId, messageId?: string): Promise<void> {
    const ids =
      messageId !== undefined
        ? [messageId]
        : (
            await this.queryAll({
              TableName: this.table,
              KeyConditionExpression: 'PK = :device AND begins_with(SK, :message)',
              FilterExpression: '#from = :from AND attribute_not_exists(delivered)',
              ExpressionAttributeNames: { '#from': 'from' }, // FROM is a reserved word
              ExpressionAttributeValues: { ':device': DEVICE(to), ':message': 'MSG#', ':from': from },
              ProjectionExpression: 'id',
              ConsistentRead: true,
            })
          ).map((item) => item.id as string);
    for (const id of ids) {
      try {
        await this.db.send(
          new DeleteCommand({
            TableName: this.table,
            Key: messageKey(to, id),
            // Checked by DynamoDB at the moment of deleting, so a delivery that started
            // since the query above still wins, and nobody deletes another's message.
            ConditionExpression: '#from = :from AND attribute_not_exists(delivered)',
            ExpressionAttributeNames: { '#from': 'from' },
            ExpressionAttributeValues: { ':from': from },
          }),
        );
      } catch (error) {
        if (!conditionFailed(error)) throw error; // already delivered, gone, or not theirs
      }
    }
  }

  async deleteMessagesBetween(a: DeviceId, b: DeviceId): Promise<void> {
    // Messages sit in their receiver's partition (D16): one query per direction, in
    // partitions the backend knows, then one delete per message. Delivered or not.
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const items = await this.queryAll({
        TableName: this.table,
        KeyConditionExpression: 'PK = :device AND begins_with(SK, :message)',
        FilterExpression: '#from = :from',
        ExpressionAttributeNames: { '#from': 'from' }, // FROM is a reserved word
        ExpressionAttributeValues: { ':device': DEVICE(to), ':message': 'MSG#', ':from': from },
        ProjectionExpression: 'id',
        ConsistentRead: true,
      });
      for (const item of items) {
        // Gone already (acknowledged, expired) is fine: deleting a missing key is a no-op.
        await this.db.send(new DeleteCommand({ TableName: this.table, Key: messageKey(to, item.id as string) }));
      }
    }
  }

  async putInvitation(invitation: InvitationRecord): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: invitationItem(invitation),
          // Never over another invitation with the same token id.
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (error) {
      if (conditionFailed(error)) return false;
      throw error;
    }
  }

  async acceptInvitation(
    tokenId: string,
    { inviter, invitee }: { inviter: DeviceId; invitee: DeviceId },
    now: number,
  ): Promise<InvitationRecord | undefined> {
    // Read first, for the initials to answer with — and to refuse most bad attempts
    // without a transaction. The transaction below checks everything again.
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: invitationKey(tokenId), ConsistentRead: true }),
    );
    if (!Item) return undefined;
    const invitation = invitationFrom(Item);
    if (invitation.inviter !== inviter || invitation.expiresAt <= now || invitation.acceptedBy !== undefined) {
      return undefined;
    }
    try {
      // One step, all or nothing: the invitation is taken — only if it is still open,
      // theirs and unexpired at this very moment — and both sides of the contact are
      // written. Two devices racing for it cannot both get it. Writing a contact that
      // already exists writes the same thing again: nothing changes (D5).
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.table,
                Key: invitationKey(tokenId),
                UpdateExpression: 'SET #acceptedBy = :invitee',
                ConditionExpression:
                  'attribute_exists(PK) AND #inviter = :inviter AND #expiresAt > :now AND attribute_not_exists(#acceptedBy)',
                ExpressionAttributeNames: { '#acceptedBy': 'acceptedBy', '#inviter': 'inviter', '#expiresAt': 'expiresAt' },
                ExpressionAttributeValues: { ':invitee': invitee, ':inviter': inviter, ':now': now },
              },
            },
            { Put: { TableName: this.table, Item: contactItem(inviter, invitee) } },
            { Put: { TableName: this.table, Item: contactItem(invitee, inviter) } },
          ],
        }),
      );
    } catch (error) {
      // Taken, expired or gone since the read: refused, like any other reason. Anything
      // else — a conflict with another transaction on it at that instant, say — is
      // thrown: nothing was written, so the invitation is still there to accept.
      if (transactionConditionFailed(error)) return undefined;
      throw error;
    }
    return { ...invitation, acceptedBy: invitee };
  }

  async isContact(owner: DeviceId, other: DeviceId): Promise<boolean> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.table,
        Key: contactKey(owner, other),
        // A message sent a moment after the invitation was accepted must be allowed.
        ConsistentRead: true,
      }),
    );
    return Item !== undefined;
  }

  async listContacts(owner: DeviceId): Promise<DeviceId[]> {
    const items = await this.queryAll({
      TableName: this.table,
      KeyConditionExpression: 'PK = :device AND begins_with(SK, :contact)',
      ExpressionAttributeValues: { ':device': DEVICE(owner), ':contact': 'CONTACT#' },
      ProjectionExpression: '#contact',
      ExpressionAttributeNames: { '#contact': 'contact' },
      // A device syncing right after a removal must not see the removed contact (D21).
      ConsistentRead: true,
    });
    return items.map((item) => item.contact as DeviceId);
  }

  async removeContact(a: DeviceId, b: DeviceId): Promise<void> {
    // Both sides or neither (D5). Deleting what is not there is not an error, so removing
    // twice, or two who never were contacts, changes nothing.
    await this.db.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: contactKey(a, b) } },
          { Delete: { TableName: this.table, Key: contactKey(b, a) } },
        ],
      }),
    );
  }

  /** A query answers at most 1 MB per page; a day of waiting messages can be more. */
  private async queryAll(
    input: Omit<QueryCommandInput, 'ExclusiveStartKey'>,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items;
  }
}

const conditionFailed = (error: unknown) =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

/** A transaction cancelled because one of its conditions did not hold. */
const transactionConditionFailed = (error: unknown) =>
  error instanceof Error &&
  error.name === 'TransactionCanceledException' &&
  ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).some(
    (reason) => reason.Code === 'ConditionalCheckFailed',
  );
