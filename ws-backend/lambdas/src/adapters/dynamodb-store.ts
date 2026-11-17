// The Store on DynamoDB — the single table from infra/dynamodb. The layout, and why no
// index beyond the generic GSI1 is needed, is design/DECISIONS.md D16:
//
//   connection   PK CONNECTION#<connectionId>   SK CONNECTION
//                GSI1PK DEVICE#<deviceId>       GSI1SK CONNECTION#<connectionId>
//   message      PK DEVICE#<to>                 SK MSG#<id>
//                + `delivered: true` once handed to the receiver (D17)
//
// The item-shaping functions are pure and unit-tested. The class that sends them to
// DynamoDB is not: it is never exercised without AWS.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
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

export function connectionItem(connection: Connection) {
  return {
    ...connectionKey(connection.connectionId),
    // The other direction: "every connection this device has", answered by GSI1. The
    // CONNECTION# prefix leaves the DEVICE# partition free for other item types later.
    GSI1PK: DEVICE(connection.deviceId),
    GSI1SK: CONNECTION(connection.connectionId),
    ...connection,
    ttl: connection.connectedAt + CONNECTION_SWEEP_SECONDS,
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

export class DynamoStore implements Store {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.db = DynamoDBDocumentClient.from(client);
  }

  async putConnection(connection: Connection): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: connectionItem(connection) }));
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: connectionKey(connectionId) }));
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
    // A GSI read is always eventually consistent; a connection opened a moment ago may
    // be missed. Harmless here: the message is stored first, and that device's own
    // fetch (a consistent read) brings it.
    const items = await this.queryAll({
      TableName: this.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :device AND begins_with(GSI1SK, :connection)',
      ExpressionAttributeValues: { ':device': DEVICE(deviceId), ':connection': 'CONNECTION#' },
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
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }
}

const conditionFailed = (error: unknown) =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';
