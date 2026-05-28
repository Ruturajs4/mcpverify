// `mcpverify compliance runs list [--limit N] [--json | --pretty]`
//
// Pretty default (TTY) → table; non-TTY → JSON.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type ComplianceRunSummary } from '../../client-class.js';
import {
  pickOutputFormat,
  emitJson,
  renderTable,
  shortId,
  truncate,
  relativeTime,
} from '../shared/output.js';

export async function listHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:        { type: 'boolean', short: 'h' },
      'api-key':   { type: 'string' },
      'api-url':   { type: 'string' },
      limit:       { type: 'string',  short: 'n', default: '20' },
      json:        { type: 'boolean' },
      pretty:      { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify compliance runs list — list recent compliance runs

USAGE
  mcpverify compliance runs list [--limit N] [--json | --pretty] [--api-key <key>]

OPTIONS
  -n, --limit N        Max rows (default: 20, max: 100)
  --json               Force JSON output
  --pretty             Force pretty table (default in TTY)
  --api-key <key>      Cloud key. Default: $MCPVERIFY_API_KEY env var.
  --api-url <url>      Override cloud endpoint (testing/dev).

OUTPUT
  TTY → pretty table (run id, server, mode, verdict, started). Pipe-friendly:
  redirecting stdout or piping to jq auto-switches to JSON. The JSON shape
  matches the ComplianceRunSummary type exported by @mcp-verify/sdk.
`);
    return;
  }

  const limit = Math.min(Math.max(Number(values.limit) || 20, 1), 100);
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

  let runs: ComplianceRunSummary[];
  try {
    runs = await client.compliance.listRuns({ limit });
  } catch (err) {
    handleApiError(err);
    return;
  }

  const fmt = pickOutputFormat({
    json: values.json === true,
    pretty: values.pretty === true,
  });

  if (fmt === 'json') {
    emitJson(runs);
    return;
  }

  // Pretty table.
  process.stdout.write(
    renderTable(runs, [
      { header: 'Run id', key: (r) => shortId(r.id) },
      { header: 'Server', key: (r) => truncate(r.server, 32) },
      { header: 'Mode', key: (r) => r.mode },
      {
        header: 'Verdict',
        key: (r) =>
          r.status === 'running' || r.status === 'pending'
            ? r.status.toUpperCase()
            : `${r.passed}/${r.total} ${r.failed > 0 ? 'FAIL' : 'PASS'}`,
      },
      { header: 'Started', key: (r) => relativeTime(r.started_at) },
    ]),
  );
}

function handleApiError(err: unknown): never {
  const e = err as Error & { status?: number };
  if (e.name === 'ApiError') {
    if (e.status === 0) {
      console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.');
      process.exit(2);
    }
    if (e.status === 401) {
      console.error('API key invalid or expired. Get one at https://mcpverify.dev/settings/api-keys');
      process.exit(2);
    }
    console.error(`API error (${e.status ?? '?'}): ${e.message}`);
    process.exit(4);
  }
  console.error(`Error: ${e.message ?? String(err)}`);
  process.exit(1);
}
