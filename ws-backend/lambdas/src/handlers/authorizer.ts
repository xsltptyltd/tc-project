import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { verifyAuthToken } from '../core/auth';

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const result = verifyAuthToken(
    event.queryStringParameters?.auth,
    Math.floor(Date.now() / 1000),
  );
  return {
    principalId: result.ok ? result.deviceId : 'anonymous',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: result.ok ? 'Allow' : 'Deny',
          Resource: event.methodArn,
        },
      ],
    },
    context: result.ok ? { deviceId: result.deviceId } : undefined,
  };
};
