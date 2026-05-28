// `mcpverify automation case run <caseId>` — dispatch a single test case
// against its bound MCP server (cloud-side execution).

import { parseArgs } from 'node:util';
import { McpVerifyClient, type CaseRunResult } from '../../client-class.js';
import { pickOutputFormat, emitJson } from '../shared/output.js';

export async function caseRunHandler(args: string[]): Promise<void> {
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
    process.stdout.write(`mcpverify automation case run — dispatch a single test case

USAGE
  mcpverify automation case run <caseId> [--api-key <key>]

ARGUMENTS
  <caseId>            Test case id (uuid / hex string)

OUTPUT
  Pretty mode: PASS/FAIL line + latency + reasoning.
  JSON mode: full CaseRunResult.
`);
    return;
  }

  const caseId = positionals[0];
  if (!caseId) {
    console.error('Error: <caseId> is required.');
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

  let result: CaseRunResult;
  try {
    result = await client.automation.runCase(caseId);
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
      if (e.status === 404) {
        console.error('Case not found.');
        process.exit(4);
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
  } else {
    const verdict = result.verdict ?? result.status;
    process.stdout.write(
      `${verdict.toUpperCase()}  ${result.runId}  ${result.latencyMs}ms\n`,
    );
    if (result.reasoning) process.stdout.write(`  reasoning: ${result.reasoning}\n`);
    if (result.error) process.stdout.write(`  error:     ${result.error}\n`);
  }

  process.exit(result.verdict === 'fail' || result.status === 'errored' ? 1 : 0);
}
