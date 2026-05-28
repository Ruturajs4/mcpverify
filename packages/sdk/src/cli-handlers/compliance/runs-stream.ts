// `mcpverify compliance runs stream <runId>` — SSE tail of an in-progress run.

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';

export async function streamHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify compliance runs stream <runId> — tail an in-progress run via SSE

USAGE
  mcpverify compliance runs stream <runId> [--json]

PRINTS
  One line per event. With --json, each line is a JSON event verbatim.
  The stream closes when the cloud emits { type: 'stream_end' }.
`);
    return;
  }

  const runId = positionals[0];
  if (!runId) { console.error('Error: run id is required'); process.exit(2); }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    await client.compliance.streamRun(runId, (evt) => {
      if (values.json) {
        process.stdout.write(JSON.stringify(evt) + '\n');
      } else {
        renderEvent(evt);
      }
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: run ${runId} not found`); process.exit(3); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}

function renderEvent(evt: Record<string, unknown>): void {
  const type = String(evt['type'] ?? 'event');
  switch (type) {
    case 'assertion_result': {
      const verdict = String(evt['verdict'] ?? '?').padEnd(5);
      const id = String(evt['assertion_id'] ?? '?');
      const latency = evt['latency_ms'] != null ? ` (${evt['latency_ms']}ms)` : '';
      const sym = verdict.trim() === 'pass' ? '+' : verdict.trim() === 'fail' ? 'x' : '-';
      process.stdout.write(`${sym} ${verdict} ${id}${latency}\n`);
      return;
    }
    case 'run_status': {
      process.stdout.write(`[status] ${String(evt['status'] ?? '?')}\n`);
      return;
    }
    case 'stream_end': {
      process.stdout.write('[stream ended]\n');
      return;
    }
    default:
      process.stdout.write(`[${type}] ${JSON.stringify(evt)}\n`);
  }
}
