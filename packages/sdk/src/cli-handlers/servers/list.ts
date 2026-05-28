// `mcpverify servers list [--json | --pretty]`

import { parseArgs } from 'node:util';
import { McpVerifyClient, type ServerSummary } from '../../client-class.js';
import {
  pickOutputFormat,
  emitJson,
  renderTable,
  truncate,
  relativeTime,
} from '../shared/output.js';

export async function listHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:       { type: 'boolean', short: 'h' },
      'api-key':  { type: 'string' },
      'api-url':  { type: 'string' },
      json:       { type: 'boolean' },
      pretty:     { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify servers list — list your registered MCP servers

USAGE
  mcpverify servers list [--json | --pretty] [--api-key <key>]
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

  let servers: ServerSummary[];
  try {
    servers = await client.servers.list();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.name === 'ApiError') {
      if (e.status === 0) {
        console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.');
        process.exit(2);
      }
      if (e.status === 401) {
        console.error('API key invalid or expired.');
        process.exit(2);
      }
      console.error(`API error (${e.status ?? '?'}): ${e.message}`);
      process.exit(4);
    }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }

  const fmt = pickOutputFormat({
    json: values.json === true,
    pretty: values.pretty === true,
  });

  if (fmt === 'json') {
    emitJson(servers);
    return;
  }

  process.stdout.write(
    renderTable(servers, [
      { header: 'Server id', key: (s) => s.id.slice(0, 12) + '…' },
      { header: 'Name', key: (s) => truncate(s.name, 28) },
      { header: 'Transport', key: (s) => s.transport },
      { header: 'Target', key: (s) => truncate(s.url ?? s.command ?? '—', 40) },
      { header: 'Auth', key: (s) => s.auth_state ?? '—' },
      { header: 'Probed', key: (s) => relativeTime(s.last_probed_at) },
    ]),
  );
}
