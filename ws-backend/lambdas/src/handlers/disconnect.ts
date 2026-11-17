import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { awsDeps } from '../adapters/aws';
import { onDisconnect } from '../core/connections';

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => {
  await onDisconnect(awsDeps(event.requestContext), event.requestContext.connectionId);
  return { statusCode: 200, body: '' };
};
