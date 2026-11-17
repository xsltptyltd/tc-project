import { MESSAGE_TTL_SECONDS } from 'tc-protocol';
import { startLocalServer } from './server';

// HOST=0.0.0.0 makes the server reachable from a phone on the same network.
// MESSAGE_TTL_SECONDS=1 makes unacknowledged messages expire after a second, to watch it.
const ttl = Number(process.env.MESSAGE_TTL_SECONDS ?? MESSAGE_TTL_SECONDS);
if (!Number.isInteger(ttl) || ttl < 1 || ttl > MESSAGE_TTL_SECONDS) {
  console.error(`MESSAGE_TTL_SECONDS must be a whole number from 1 to ${MESSAGE_TTL_SECONDS}`);
  process.exit(1);
}

startLocalServer(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', {
  messageTtlSeconds: ttl,
}).then((server) => {
  console.log(`tap-chat local server listening on ${server.url}, messages kept ${ttl} s at most`);
});
