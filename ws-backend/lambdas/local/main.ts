import { INVITATION_TTL_MAX_SECONDS, INVITATION_TTL_SECONDS, MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { DynamoStore } from '../src/adapters/dynamodb-store';
import { FakeDynamoDB } from '../test/fake-dynamodb';
import { startLocalServer } from './server';

// HOST=0.0.0.0 makes the server reachable from a phone on the same network.
// MESSAGE_TTL_SECONDS=1 makes unacknowledged messages expire after a second, to watch it.
// INVITATION_TTL_SECONDS=60 leaves a minute to accept an invitation (default 20 s).
// TC_STORE=dynamodb runs on the DynamoDB store the Lambdas use, talking to the in-memory
// stand-in for the DynamoDB client (test/fake-dynamodb.ts) — not to AWS.
function seconds(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    console.error(`${name} must be a whole number from 1 to ${max}`);
    process.exit(1);
  }
  return value;
}

const ttl = seconds('MESSAGE_TTL_SECONDS', MESSAGE_TTL_SECONDS, MESSAGE_TTL_SECONDS);
const invitationTtl = seconds('INVITATION_TTL_SECONDS', INVITATION_TTL_SECONDS, INVITATION_TTL_MAX_SECONDS);

const storeName = process.env.TC_STORE ?? 'memory';
if (storeName !== 'memory' && storeName !== 'dynamodb') {
  console.error('TC_STORE must be memory (the default) or dynamodb');
  process.exit(1);
}

startLocalServer(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', {
  messageTtlSeconds: ttl,
  invitationTtlSeconds: invitationTtl,
  ...(storeName === 'dynamodb' && { store: new DynamoStore('tc-local', new FakeDynamoDB(100)) }),
}).then((server) => {
  console.log(
    `tap-chat local server listening on ${server.url}, messages kept ${ttl} s at most, ` +
      `invitations valid ${invitationTtl} s, ` +
      (storeName === 'dynamodb' ? 'store: DynamoDB (stand-in client, not AWS)' : 'store: memory'),
  );
});
