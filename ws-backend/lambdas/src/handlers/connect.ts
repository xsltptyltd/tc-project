import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { DeviceIdSchema } from 'tc-protocol';
import { awsDeps } from '../adapters/aws';
import { onConnect } from '../core/connections';

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => {
  // Set by the authorizer; never read the device id from the request itself.
  const context = event.requestContext as { authorizer?: { principalId?: string } };
  const deviceId = DeviceIdSchema.safeParse(context.authorizer?.principalId);
  if (!deviceId.success) return { statusCode: 401, body: '' };
  await onConnect(awsDeps(event.requestContext), event.requestContext.connectionId, deviceId.data);
  return { statusCode: 200, body: '' };
};
