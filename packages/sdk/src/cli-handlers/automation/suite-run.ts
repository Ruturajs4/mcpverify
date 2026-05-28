// `mcpverify automation suite run <suiteId>` — execute a cloud-stored suite
// LOCALLY via the cloud-eval flow (T-184). Steps execute on this machine
// (especially against stdio MCP servers the cloud can't reach); each step's
// captured response is POSTed to /api/v1/automation/.../evaluate for scoring.

import { parseArgs } from 'node:util';
import {
  runSuiteViaCloudEval,
  CloudEvalApiError,
  type CloudEvalCaseEvent,
} from '../../automation/cloud-eval-runner.js';

export async function runHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      'local-config': { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify automation suite run — execute a cloud-stored suite locally

USAGE
  mcpverify automation suite run <suiteId> [--local-config <file>] [--api-key KEY]

ARGUMENTS
  <suiteId>            Cloud id of the suite to run.

OPTIONS
  --local-config <f>   Required when the suite is bound to a stdio server.
                       JSON file describing the local server command + any
                       local-only fixture values to interpolate.
  --api-key <key>      MCPVerify cloud key. Default: $MCPVERIFY_API_KEY.
  --api-url <url>      Override API base URL. Default: $MCPVERIFY_API_URL or
                       https://mcpverify.dev.
  --verbose            Print step-level details to stderr.
  --quiet, -q          Suppress informational output.

NOTES
  - Steps execute LOCALLY; each step's captured JSON-RPC response is POSTed
    to the cloud /evaluate endpoint for scoring. Your trace stays on your
    machine; only the response data + step metadata cross the wire.
  - HTTP/SSE-server suites: temporarily run via the dashboard
    (https://mcpverify.dev/suites/<id>) until the next patch release.
  - Agentic cases skip with a clear message (LLM judge runs cloud-side).
`);
    return;
  }

  const suiteId = positionals[0];
  if (!suiteId) {
    console.error('Error: mcpverify automation suite run requires a <suiteId>.');
    console.error('  mcpverify automation suite run <suiteId> --local-config local.json');
    process.exit(2);
  }

  const onCase = (event: CloudEvalCaseEvent): void => {
    if (values.quiet) return;
    if (event.phase === 'start') {
      process.stderr.write(`[case] ${event.caseName} (${event.kind}) → running...\n`);
    } else if (event.phase === 'done') {
      const v = event.verdict ?? '-';
      process.stderr.write(`[case] ${event.caseName} → ${event.status} (verdict=${v}, ${event.latencyMs}ms)\n`);
    } else if (event.phase === 'skipped') {
      process.stderr.write(`[case] ${event.caseName} → skipped (${event.error ?? 'no reason'})\n`);
    }
  };

  try {
    const result = await runSuiteViaCloudEval({
      suiteId,
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
      ...(values['local-config'] ? { localConfigPath: values['local-config'] as string } : {}),
      quiet: !!values.quiet,
      verbose: !!values.verbose,
      onCase,
    });

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!values.quiet) {
      process.stderr.write(
        `\n[summary] ${result.passed}/${result.caseCount} passed, ` +
          `${result.failed} failed, ${result.errored} errored, ${result.skipped} skipped\n` +
          `[summary] view: ${result.reportUrl}\n`,
      );
    }
    process.exit(result.failed > 0 || result.errored > 0 ? 1 : 0);
  } catch (err) {
    if (err instanceof CloudEvalApiError) {
      console.error(`Error (${err.status}): ${err.message}`);
      process.exit(2);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
