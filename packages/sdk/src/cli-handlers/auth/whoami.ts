// `mcpverify auth whoami` — validate api-key and print the authenticated user.

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { pickOutputFormat, emitJson } from '../shared/output.js';

export async function whoamiHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      json:      { type: 'boolean' },
      pretty:    { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify auth whoami — verify your api-key and print the authenticated user

USAGE
  mcpverify auth whoami [--json | --pretty] [--api-key <key>]
`);
    return;
  }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(2);
  }

  let me;
  try {
    me = await client.auth.whoami();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) {
      console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.');
      process.exit(2);
    }
    if (e.status === 401) {
      console.error('API key invalid or expired.');
      process.exit(2);
    }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }

  const fmt = pickOutputFormat({ json: values.json === true, pretty: values.pretty === true });
  if (fmt === 'json') {
    emitJson(me);
    return;
  }
  const authKind = me.actor.type === 'api_key' ? 'api-key' : 'session';
  process.stdout.write(`Authenticated as ${me.user.email}${me.user.name ? ` (${me.user.name})` : ''}\n`);
  process.stdout.write(`User id:   ${me.user.id}\n`);
  process.stdout.write(`Auth via:  ${authKind}\n`);
}
