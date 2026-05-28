// `mcpverify automation suite delete <suiteId> --yes`

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';

export async function suiteDeleteHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify automation suite delete <suiteId> — delete a test suite (and all its cases)

USAGE
  mcpverify automation suite delete <suiteId> --yes

NOTE
  Cascades to delete all cases inside the suite. test_runs are preserved
  (suite_id is set NULL — historical run data stays).
`);
    return;
  }

  const id = positionals[0];
  if (!id) { console.error('Error: suite id is required'); process.exit(2); }
  if (!values.yes) {
    console.error(`Refusing to delete suite ${id} without --yes. This will cascade to all cases.`);
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
    await client.automation.suites.delete(id);
    process.stdout.write(`Deleted suite ${id}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: suite ${id} not found`); process.exit(3); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
