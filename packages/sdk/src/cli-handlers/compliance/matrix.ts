// `mcpverify compliance matrix` — per-server pass/fail rollup over recent runs.
//
// Aggregation is client-side (from listRuns) so no new endpoint is required.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type MatrixResult } from '../../client-class.js';
import { pickOutputFormat, emitJson, renderTable, truncate, relativeTime } from '../shared/output.js';

export async function matrixHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      limit:     { type: 'string', short: 'l' },
      json:      { type: 'boolean' },
      pretty:    { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify compliance matrix — per-server compliance rollup over recent runs

USAGE
  mcpverify compliance matrix [--limit 100] [--json | --pretty]

WHAT IT SHOWS
  For each server you've run compliance probes against, the aggregate
  pass/fail/warn counts and the latest verdict + run timestamp.
  Default window is the last 100 runs (the cloud cap).
`);
    return;
  }

  const limit = values.limit ? Math.max(1, Math.min(100, Number.parseInt(values.limit as string, 10))) : 100;

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  let result: MatrixResult;
  try {
    result = await client.compliance.matrix({ limit });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }

  const fmt = pickOutputFormat({ json: values.json === true, pretty: values.pretty === true });
  if (fmt === 'json') { emitJson(result); return; }

  if (result.cells.length === 0) {
    process.stdout.write('No compliance runs yet. Run one: mcpverify compliance run --transport http --url <url>\n');
    return;
  }

  process.stdout.write(
    renderTable(result.cells, [
      { header: 'Server', key: (c) => truncate(c.server, 36) },
      { header: 'Runs', key: (c) => String(c.total_runs) },
      { header: 'Last', key: (c) => c.last_verdict },
      { header: 'Pass rate', key: (c) => `${(c.pass_rate * 100).toFixed(0)}%` },
      { header: 'P/F/W/S', key: (c) => `${c.passed}/${c.failed}/${c.warned}/${c.skipped}` },
      { header: 'Last run', key: (c) => relativeTime(c.last_run_at) },
    ]),
  );

  // Red Flags Bundle Phase C: truncation footer. When the window is
  // saturated (truncated === true), the aggregates above are an
  // incomplete rollup and the web matrix view has the complete picture.
  if (result.truncated) {
    process.stdout.write(
      `\nNote: showing aggregates from the last ${result.window_size} runs. ` +
        `Some history was truncated; see the web matrix view for the full rollup.\n`,
    );
  }
}
