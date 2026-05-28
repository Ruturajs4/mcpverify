// `mcpverify automation fixture list` — list user's fixtures.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type FixtureSummary } from '../../client-class.js';
import { pickOutputFormat, emitJson, renderTable, truncate, relativeTime } from '../shared/output.js';

export async function fixtureListHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify automation fixture list — list your fixtures (variable / secret / dynamic-http)

USAGE
  mcpverify automation fixture list [--json | --pretty] [--api-key <key>]

NOTE
  Fixture VALUES are never returned by the API — only metadata.
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

  let fixtures: FixtureSummary[];
  try {
    fixtures = await client.automation.fixtures.list();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }

  const fmt = pickOutputFormat({ json: values.json === true, pretty: values.pretty === true });
  if (fmt === 'json') { emitJson(fixtures); return; }

  process.stdout.write(
    renderTable(fixtures, [
      { header: 'Name', key: (f) => truncate(f.name, 24) },
      { header: 'Kind', key: (f) => f.kind },
      { header: 'TTL', key: (f) => (f.ttl_seconds ? `${f.ttl_seconds}s` : '—') },
      { header: 'Source', key: (f) => f.source ? `${f.source.method} ${truncate(f.source.url, 36)}` : '—' },
      { header: 'Updated', key: (f) => relativeTime(f.updated_at) },
    ]),
  );
}
