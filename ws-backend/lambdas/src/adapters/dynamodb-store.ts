// The Store on DynamoDB — the single table from infra/dynamodb. The layout, and why no
// index is needed, is design/DECISIONS.md D16:
//
//   connection, by id       PK CONNECTION#<connectionId>   SK CONNECTION
//   connection, by device   PK DEVICE#<deviceId>           SK CONNECTION#<connectionId>
//   message                 PK DEVICE#<to>                 SK MSG#<id>
//                           + `delivered: true` once handed to the receiver (D17)
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
import type { Connection, Store } from '../core/ports';

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

/** The part of the DynamoDB document client the store uses; tests pass a stand-in. */
export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

export class DynamoStore implements Store {
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
