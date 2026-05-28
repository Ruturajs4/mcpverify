// `mcpverify servers probe <serverId>` — re-probe a registered server for auth state + tool discovery.

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

export async function probeHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      json:      { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify servers probe <serverId> — re-probe auth state + tool discovery

USAGE
  mcpverify servers probe <serverId> [--json]

WHAT IT DOES
  Hits the server's initialize → tools/list endpoints to refresh:
    - auth_state ('ok' | 'oauth_required' | 'unreachable' | …)
    - last_probed_at timestamp
    - cached tool count
`);
    return;
  }

  const id = positionals[0];
  if (!id) { console.error('Error: server id is required'); process.exit(2); }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    const result = await client.servers.probe(id);
    if (values.json) { emitJson(result); return; }
    if (result.ok) {
      process.stdout.write(`Probe ok (auth: ${result.auth_state ?? '—'}, tools: ${result.tool_count ?? '—'})\n`);
      process.exit(0);
    } else {
      process.stdout.write(`Probe failed: ${result.error ?? 'unknown'} (auth_state: ${result.auth_state ?? '—'})\n`);
      process.exit(1);
    }
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: server ${id} not found`); process.exit(3); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
