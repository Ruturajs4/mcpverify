// `mcpverify compliance view <runId> [--json | --pretty]`
//
// Print one run's detail. Pretty mode: header + summary line + grouped
// assertion list (failed first, then warned, then passed/skipped). JSON
// mode: raw ComplianceRunDetail wire shape.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type ComplianceRunDetail } from '../../client-class.js';
import {
  pickOutputFormat,
  emitJson,
  relativeTime,
} from '../shared/output.js';

export async function viewHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
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
    process.stdout.write(`mcpverify compliance view — show one compliance run's full breakdown

USAGE
  mcpverify compliance view <runId> [--json | --pretty] [--api-key <key>]

ARGUMENTS
  <runId>              The run's id (uuid or short hash from \`runs list\`)

OPTIONS
  --json               Force JSON output (full ComplianceRunDetail shape)
  --pretty             Force pretty (default in TTY)
  --api-key <key>      Cloud key. Default: $MCPVERIFY_API_KEY env var.
`);
    return;
  }

  const runId = positionals[0];
  if (!runId) {
    console.error('Error: <runId> is required.');
    console.error('  mcpverify compliance view <runId>');
    process.exit(2);
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

  let detail: ComplianceRunDetail;
  try {
    detail = await client.compliance.getRun(runId);
  } catch (err) {
    handleApiError(err);
    return;
  }

  const fmt = pickOutputFormat({
    json: values.json === true,
    pretty: values.pretty === true,
  });

  if (fmt === 'json') {
    emitJson(detail);
    return;
  }

  // Pretty mode.
  const lat = detail.completed_at && detail.started_at
    ? `${detail.completed_at - detail.started_at}ms`
    : '—';
  process.stdout.write(`
RUN ${detail.id}
  Server      ${detail.server}
  Mode        ${detail.mode}
  Started     ${relativeTime(detail.started_at)}
  Latency     ${lat}
  Auth state  ${detail.auth_state ?? '—'}
  Status      ${detail.status.toUpperCase()}
  Verdict     ${detail.passed}/${detail.total}  (${detail.failed} fail · ${detail.warned} warn · ${detail.skipped} skip)

`);

  // Group assertions by verdict.
  const fail = detail.assertions.filter((a) => a.verdict === 'fail');
  const warn = detail.assertions.filter((a) => a.verdict === 'warn');
  const pass = detail.assertions.filter((a) => a.verdict === 'pass');
  const skip = detail.assertions.filter((a) => a.verdict === 'skip');

  if (fail.length > 0) {
    process.stdout.write('FAILURES\n');
    for (const a of fail) {
      process.stdout.write(`  ✗ ${a.assertion_id}  [${a.severity}]\n`);
      if (a.observed) process.stdout.write(`     observed: ${a.observed}\n`);
      if (a.expected) process.stdout.write(`     expected: ${a.expected}\n`);
      if (a.error) process.stdout.write(`     error:    ${a.error}\n`);
      if (a.remediation) process.stdout.write(`     fix:      ${a.remediation}\n`);
    }
    process.stdout.write('\n');
  }
  if (warn.length > 0) {
    process.stdout.write('WARNINGS\n');
    for (const a of warn) {
      process.stdout.write(`  ⚠ ${a.assertion_id}  ${a.observed ?? ''}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`Passed:  ${pass.length}    Skipped: ${skip.length}\n`);
}

function handleApiError(err: unknown): never {
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
    if (e.status === 404) {
      console.error('Run not found.');
      process.exit(4);
    }
    console.error(`API error (${e.status ?? '?'}): ${e.message}`);
    process.exit(4);
  }
  console.error(`Error: ${e.message ?? String(err)}`);
  process.exit(1);
}
