import { startLocalServer } from './server';

// HOST=0.0.0.0 makes the server reachable from a phone on the same network.
startLocalServer(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1').then((server) => {
  console.log(`tap-chat local server listening on ${server.url}`);
});
