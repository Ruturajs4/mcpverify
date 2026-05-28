// LEGACY: `mcpverify studio run <suite.json>` — pre-T-180 path that ships a
// YAML/JSON suite file to the cloud for scoring. Kept working for backward
// compat with v0.2.x consumers. Phase 2 may rebind this under
// `automation suite <verb>` (see D4 in the plan).

import { parseArgs } from 'node:util';
import {
  runStudioSuite,
  StudioApiError,
  StudioSuiteFileError,
} from '../studio.js';

export async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help:               { type: 'boolean', short: 'h' },
      'api-key':          { type: 'string' },
      'api-url':          { type: 'string' },
      quiet:              { type: 'boolean', short: 'q' },
      'no-upsert':        { type: 'boolean' },
      'no-fail-on-error': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify studio run <file> — ship a YAML/JSON suite to the cloud (legacy)

USAGE
  mcpverify studio run <suite.json> [--api-key <key>] [--no-upsert]

ARGUMENTS
  <suite.json>         Path to a suite JSON file (see studio-suite-example.json)

NOTE
  This is the legacy "ship a file → cloud scores it" path from v0.1.x.
  For most users, prefer \`mcpverify automation suite run <suiteId>\` which
  runs an existing cloud-stored suite locally. This command is preserved
  for backward compatibility with existing CI scripts.
`);
    return;
  }

  // The legacy positional layout was \`mcpverify studio run <file>\` — when this
  // handler is invoked, positionals[0] is \`run\` and positionals[1] is the file
  // (we receive the slice after 'studio' so positional 0 is now 'run' if the
  // surface dispatcher passed full args, or the file if pre-sliced).
  const suitePath = positionals[positionals.length - 1];
  if (!suitePath || suitePath === 'run') {
    console.error('Error: mcpverify studio run requires a path to a suite JSON file.');
    console.error('  mcpverify studio run path/to/suite.json --api-key $MCPVERIFY_API_KEY');
    process.exit(2);
  }

  try {
    if (!values.quiet) {
      console.error('MCPVerify Studio — running a CI suite against the cloud.');
      console.error(`Suite file: ${suitePath}`);
      if (values['api-url']) console.error(`API URL:    ${values['api-url']}`);
      console.error('');
    }

    const result = await runStudioSuite({
      suitePath,
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
      upsertSuite: !values['no-upsert'],
      quiet: values.quiet === true,
    });

    const { passed, failed, errored, total } = result.summary;
    const badCount = failed + errored;
    if (!values.quiet) {
      console.error(`Done: ${passed}/${total} passed, ${failed} failed, ${errored} errored.`);
      console.error(`Report: ${result.reportUrl}`);
    }
    process.stdout.write(JSON.stringify({
      suiteId: result.suiteId,
      reportUrl: result.reportUrl,
      summary: result.summary,
      cases: result.cases.map((c) => ({
        caseId: c.caseId,
        caseName: c.caseName,
        kind: c.kind,
        status: c.status,
        verdict: c.verdict,
        latencyMs: c.latencyMs,
        runId: c.runId,
      })),
    }) + '\n');

    if (badCount > 0 && !values['no-fail-on-error']) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof StudioSuiteFileError) {
      console.error(`Suite file error: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof StudioApiError) {
      if (err.status === 0) {
        console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.');
        process.exit(2);
      }
      console.error(`API error (${err.status}) at ${err.endpoint}: ${err.message}`);
      if (err.status === 401) {
        console.error('Hint: confirm MCPVERIFY_API_KEY is set and valid.');
      } else if (err.status === 402) {
        console.error('Hint: your tier has hit its monthly run cap. See https://mcpverify.dev/pricing.');
      }
      process.exit(2);
    }
    const e = err as Error;
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(2);
  }
}
