// Command-line client for local development. Identities are stored unencrypted in
// ./.tc/<name>.json — fine for trying things out, not for real use.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { generateIdentity, init, type Identity } from 'tc-crypto';
import { DeviceIdSchema } from 'tc-protocol';
import { TcClient } from 'tc-client';

const USAGE = `usage:
  cli init <name>                  create an identity and print its device id
  cli id <name>                    print the device id
  cli chat <name> --to <deviceId>  connect; each line typed is sent, incoming lines are printed

environment:
  TC_URL   websocket url (default ws://127.0.0.1:8787)`;

const profilePath = (name: string) => join(process.cwd(), '.tc', `${name}.json`);

function load(name: string): Identity {
  if (!existsSync(profilePath(name))) fail(`no identity "${name}" — run: cli init ${name}`);
  return JSON.parse(readFileSync(profilePath(name), 'utf8')) as Identity;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, name, ...rest] = process.argv.slice(2);
  if (!command || !name || !/^[A-Za-z0-9_-]+$/.test(name)) fail(USAGE);
  await init();

  if (command === 'init') {
    if (existsSync(profilePath(name))) fail(`identity "${name}" already exists`);
    const identity = generateIdentity();
    mkdirSync(join(process.cwd(), '.tc'), { recursive: true });
    writeFileSync(profilePath(name), JSON.stringify(identity, null, 2), { mode: 0o600 });
    console.log(identity.deviceId);
    return;
  }

  if (command === 'id') {
    console.log(load(name).deviceId);
    return;
  }

  if (command === 'chat') {
    const to = DeviceIdSchema.safeParse(rest[0] === '--to' ? rest[1] : undefined);
    if (!to.success) fail(USAGE);
    const identity = load(name);
    const client = new TcClient(identity, process.env.TC_URL ?? 'ws://127.0.0.1:8787');
    client.onMessage((m) => console.log(`< ${m.from.slice(0, 8)}…  ${m.text}`));
    let quitting = false;
    client.onClose(() => {
      if (!quitting) fail('connection closed');
    });
    await client.connect();
    console.log(`you are   ${identity.deviceId}`);
    console.log(`writing to ${to.data}`);
    console.log('connected — type a message and press enter (ctrl-d to quit)');
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      if (!line.trim()) continue;
      await client.send(to.data, line);
      console.log('> sent');
    }
    quitting = true;
    await client.close();
    return;
  }

  fail(USAGE);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
