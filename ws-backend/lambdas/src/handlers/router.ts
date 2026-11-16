import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { awsDeps } from '../adapters/aws';
import { onMessage } from '../core/router';

/** The `$default` route: every frame a client sends after connecting. */
export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => {
  await onMessage(awsDeps(), event.requestContext.connectionId, event.body ?? '');
  return { statusCode: 200, body: '' };
};
