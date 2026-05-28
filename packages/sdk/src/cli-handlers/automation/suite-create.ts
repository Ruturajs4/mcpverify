// `mcpverify automation suite create --name X --server-id Y [--description Z]`

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

export async function suiteCreateHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:         { type: 'boolean', short: 'h' },
      'api-key':    { type: 'string' },
      'api-url':    { type: 'string' },
      name:         { type: 'string' },
      'server-id':  { type: 'string' },
      description:  { type: 'string' },
      json:         { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify automation suite create — create a test suite

USAGE
  mcpverify automation suite create --name <n> --server-id <id> [--description <d>]

REQUIRED
  --name <n>          Suite name (1-120 chars)
  --server-id <id>    Server to bind the suite to (one-suite-one-server)

OPTIONAL
  --description <d>   Free-form note (max 2000 chars)

NOTE
  Use \`mcpverify servers list\` to find a server id.
`);
    return;
  }

  const name = values.name as string | undefined;
  const serverId = values['server-id'] as string | undefined;
  if (!name || !serverId) {
    console.error('Error: --name and --server-id are required');
    process.exit(2);
  }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    const created = await client.automation.suites.create({
      name,
      serverId,
      ...(values.description ? { description: values.description as string } : {}),
    });
    if (values.json) { emitJson(created); return; }
    process.stdout.write(`Created suite "${created.name}" (id ${created.id})\n`);
    process.stdout.write(`Bound to server ${serverId}\n`);
    process.stdout.write(`Add cases via the web app or \`mcpverify automation case create --suite ${created.id} --yaml file.yaml\`\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: server ${serverId} not found (or not yours)`); process.exit(3); }
    if (e.status === 400) { console.error(`Error: ${e.message}`); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
