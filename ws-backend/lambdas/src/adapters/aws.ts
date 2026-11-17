// The Deps used when running in Lambda: the DynamoDB Store and a Transport that posts
// through the API Gateway management endpoint. Written against real AWS only — nothing
// here runs in tests, which use the in-memory adapters.
import { randomUUID } from 'node:crypto';
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { MESSAGE_TTL_SECONDS } from 'tc-protocol';
import type { Deps, Transport } from '../core/ports';
import { DynamoStore } from './dynamodb-store';

// Kept across invocations of a warm Lambda; one deployment talks to one endpoint.
let store: DynamoStore | undefined;
const managementClients = new Map<string, ApiGatewayManagementApiClient>();

function apiGatewayTransport(endpoint: string): Transport {
  const client =
    managementClients.get(endpoint) ??
    managementClients
      .set(endpoint, new ApiGatewayManagementApiClient({ endpoint }))
      .get(endpoint)!;
  return {
    async post(connectionId, event) {
      try {
        await client.send(
          new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(event) }),
        );
        return true;
      } catch (error) {
        // "That connection no longer exists" is an answer, not a failure.
        if (error instanceof GoneException) return false;
        throw error;
      }
    },
  };
}

/**
 * Deps for one websocket event. The request context names the API and stage the event
 * came in on, which is where answers must be posted back.
 */
export function awsDeps(requestContext: { domainName: string; stage: string }): Deps {
  const table = process.env.DYNAMODB_TABLE;
  if (!table) throw new Error('DYNAMODB_TABLE is not set');
  store ??= new DynamoStore(table);
  return {
    store,
    transport: apiGatewayTransport(`https://${requestContext.domainName}/${requestContext.stage}`),
    now: () => Math.floor(Date.now() / 1000),
    newId: randomUUID,
    messageTtlSeconds: MESSAGE_TTL_SECONDS,
  };
}
