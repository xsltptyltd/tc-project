// What the Lambdas run with. Building the clients does not reach AWS; nothing is sent.
import { afterEach, describe, expect, it } from 'vitest';
import { INVITATION_TTL_SECONDS, MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { awsDeps } from '../src/adapters/aws';
import { DynamoStore } from '../src/adapters/dynamodb-store';

const context = { domainName: 'abc123.execute-api.us-west-2.amazonaws.com', stage: 'dev' };

afterEach(() => {
  delete process.env.DYNAMODB_TABLE;
});

describe('the deps a Lambda runs with', () => {
  it('keep everything in the one DynamoDB table: messages, connections, invitations, contacts', () => {
    process.env.DYNAMODB_TABLE = 'tc-dev-1';
    const deps = awsDeps(context);
    expect(deps.store).toBeInstanceOf(DynamoStore);
    expect(deps.contacts).toBe(deps.store);
  });

  it('use the deployed lifetimes: 24 hours for a message, 20 seconds for an invitation', () => {
    process.env.DYNAMODB_TABLE = 'tc-dev-1';
    const deps = awsDeps(context);
    expect(deps.messageTtlSeconds).toBe(MESSAGE_TTL_SECONDS);
    expect(deps.invitationTtlSeconds).toBe(INVITATION_TTL_SECONDS);
  });

  it('refuse to start without a table', () => {
    expect(() => awsDeps(context)).toThrow('DYNAMODB_TABLE is not set');
  });
});
