// `mcpverify automation suite list [--json | --pretty]`

import { parseArgs } from 'node:util';
import { McpVerifyClient, type SuiteListResult } from '../../client-class.js';
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
    process.stdout.write(`mcpverify automation suite list — list your suites

USAGE
  mcpverify automation suite list [--json | --pretty] [--api-key <key>]
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

  let result: SuiteListResult;
  try {
    result = await client.automation.listSuitesWithMeta();
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
    emitJson(result);
    return;
  }

  process.stdout.write(
    renderTable(result.suites, [
      { header: 'Suite id', key: (s) => s.id.slice(0, 12) + '…' },
      { header: 'Name', key: (s) => truncate(s.name, 30) },
      { header: 'Cases', key: (s) => String(s.case_count), align: 'right' },
      { header: 'Last verdict', key: (s) => s.last_verdict ?? '—' },
      { header: 'Last run', key: (s) => relativeTime(s.last_run_at) },
    ]),
  );

  // Red Flags Bundle Phase D: "Showing N of M" footer when truncated.
  if (result.suites.length < result.total) {
    process.stdout.write(
      `\nShowing ${result.suites.length} of ${result.total} suites.\n`,
    );
  }
}
