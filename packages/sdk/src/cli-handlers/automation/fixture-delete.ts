// `mcpverify automation fixture delete <name>` — destructive; requires --yes.

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';

export async function fixtureDeleteHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify automation fixture delete <name> — delete a fixture

USAGE
  mcpverify automation fixture delete <name> --yes
`);
    return;
  }

  const name = positionals[0];
  if (!name) { console.error('Error: fixture name is required'); process.exit(2); }
  if (!values.yes) {
    console.error(`Refusing to delete fixture "${name}" without --yes`);
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
    await client.automation.fixtures.delete(name);
    process.stdout.write(`Deleted fixture "${name}"\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: fixture "${name}" not found`); process.exit(3); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
