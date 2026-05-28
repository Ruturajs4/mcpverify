// `mcpverify automation suite run-local <suiteId> --local-config <file>` —
// alias of `suite run` with --local-config required. Kept as a separate
// command name for CI scripts already wired to this surface; the underlying
// implementation is identical (T-184 cloud-eval flow).

import { parseArgs } from 'node:util';
import {
  runSuiteViaCloudEval,
  CloudEvalApiError,
  type CloudEvalCaseEvent,
} from '../../automation/cloud-eval-runner.js';

export async function runLocalHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify automation suite run-local — execute a suite against a LOCAL stdio MCP

USAGE
  mcpverify automation suite run-local <suiteId> --local-config <file>

This is an alias for \`mcpverify automation suite run\` with --local-config
required. Steps execute locally against the stdio command in your
--local-config; each step's response is POSTed to the cloud /evaluate
endpoint for scoring.

ARGUMENTS
  <suiteId>            Cloud id of the suite to run.

OPTIONS
  --local-config <f>   REQUIRED. Path to a JSON file describing the local
                       stdio server (command/args/env) and any local-only
                       fixture values to inject.
  --api-key <key>      MCPVerify cloud key. Default: \$MCPVERIFY_API_KEY.
  --api-url <url>      Override API base URL. Default: \$MCPVERIFY_API_URL or
                       https://mcpverify.dev.
  --verbose            Print step-level details to stderr.
  --quiet, -q          Suppress informational output.

EXAMPLE LOCAL CONFIG
  {
    "server": { "command": "node", "args": ["dist/server.js"] },
    "fixtures": { "OPENAI_KEY": "sk-..." }
  }
`);
    return;
  }

  const suiteId = positionals[0];
  if (!suiteId) {
    console.error('Error: mcpverify automation suite run-local requires a <suiteId>.');
    process.exit(2);
  }
  if (!values['local-config']) {
    console.error('Error: --local-config <file> is required for run-local.');
    console.error('  See `mcpverify automation suite run-local --help` for the config shape.');
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
      localConfigPath: values['local-config'] as string,
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
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
