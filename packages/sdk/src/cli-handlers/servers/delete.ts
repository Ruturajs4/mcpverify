// `mcpverify servers delete <serverId> --yes`

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';

export async function deleteHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      yes:       { type: 'boolean', short: 'y' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify servers delete <serverId> — remove a registered server

USAGE
  mcpverify servers delete <serverId> --yes

NOTE
  Suites bound to this server will be detached (server_id set NULL on the
  suite). Historical runs / case runs are preserved.
`);
    return;
  }

  const id = positionals[0];
  if (!id) { console.error('Error: server id is required'); process.exit(2); }
  if (!values.yes) { console.error(`Refusing to delete server ${id} without --yes`); process.exit(2); }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    await client.servers.delete(id);
    process.stdout.write(`Deleted server ${id}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: server ${id} not found`); process.exit(3); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
