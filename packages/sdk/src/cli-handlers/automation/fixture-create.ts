// `mcpverify automation fixture create <kind> <name> [...]`
//
// Three sub-shapes:
//   fixture create variable <name> --value <v>
//   fixture create secret   <name> --stdin       (value piped on stdin)
//   fixture create secret   <name> --value <v>   (escape hatch — value visible in argv)
//   fixture create dynamic-http <name> --method POST --url URL --extract '$.body.token' --ttl 3600
//
// Secret-via-stdin is preferred — keeps the value out of process argv + shell history.

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

export async function fixtureCreateHandler(args: string[]): Promise<void> {
  const [kind, ...rest] = args;
  if (!kind || kind === '--help' || kind === '-h') {
    process.stdout.write(`mcpverify automation fixture create — create a fixture

USAGE
  mcpverify automation fixture create variable <name> --value <value>
  mcpverify automation fixture create secret   <name> --stdin
  mcpverify automation fixture create secret   <name> --value <value>
  mcpverify automation fixture create dynamic-http <name> --method POST --url <url> \\
                                       --extract <jsonpath> --ttl <seconds>

NOTES
  - 'secret' fixtures are AES-256-GCM encrypted at rest. Prefer --stdin so the
    value never appears in shell history / argv.
  - 'dynamic-http' fixtures refresh themselves by hitting your auth endpoint
    on a schedule (e.g. OAuth refresh token). Use --extract to point at the
    JSON path of the value to capture (e.g. '$.access_token').
`);
    return;
  }

  if (!['variable', 'secret', 'dynamic-http'].includes(kind)) {
    console.error(`Unknown fixture kind: ${kind}. Use one of: variable, secret, dynamic-http`);
    process.exit(2);
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      value:     { type: 'string', short: 'v' },
      stdin:     { type: 'boolean' },
      json:      { type: 'boolean' },
      // dynamic-http-only
      method:    { type: 'string' },
      url:       { type: 'string' },
      extract:   { type: 'string' },
      ttl:       { type: 'string' },
      header:    { type: 'string', multiple: true, short: 'H' },
      body:      { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  });

  const name = positionals[0];
  if (!name) {
    console.error(`Error: fixture name is required (e.g. \`mcpverify automation fixture create ${kind} my-token ...\`)`);
    process.exit(2);
  }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    let created;
    if (kind === 'variable') {
      const value = values.stdin ? await readStdinValue() : (values.value as string | undefined);
      if (!value) { console.error('Error: --value <v> or --stdin is required'); process.exit(2); }
      created = await client.automation.fixtures.createVariable(name, value);
    } else if (kind === 'secret') {
      const value = values.stdin ? await readStdinValue() : (values.value as string | undefined);
      if (!value) {
        console.error('Error: secret fixtures require --stdin (preferred) or --value <v>');
        console.error('  echo "$SECRET" | mcpverify automation fixture create secret my-token --stdin');
        process.exit(2);
      }
      created = await client.automation.fixtures.createSecret(name, value);
    } else {
      // dynamic-http
      const method = (values.method as string | undefined) ?? 'POST';
      const url = values.url as string | undefined;
      const extract = values.extract as string | undefined;
      const ttlRaw = values.ttl as string | undefined;
      if (!url || !extract || !ttlRaw) {
        console.error('Error: dynamic-http requires --url, --extract, and --ttl');
        process.exit(2);
      }
      const ttlSeconds = Number.parseInt(ttlRaw, 10);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) {
        console.error('Error: --ttl must be a positive integer (seconds)');
        process.exit(2);
      }
      const headers: Record<string, string> = {};
      for (const raw of (values.header ?? []) as string[]) {
        const i = raw.indexOf(':');
        if (i <= 0) { console.error(`Error: -H must be "Name: value" (got "${raw}")`); process.exit(2); }
        headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
      }
      const source: Record<string, unknown> = { type: 'http', method, url, extract };
      if (Object.keys(headers).length > 0) source.headers = headers;
      if (values.body) source.body = values.body;
      created = await client.automation.fixtures.createDynamicHttp({ name, source, ttlSeconds });
    }
    if (values.json) { emitJson(created); return; }
    process.stdout.write(`Created fixture "${created.name}" (${created.kind})\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 409) { console.error(`Error: fixture "${name}" already exists`); process.exit(3); }
    if (e.status === 400) { console.error(`Error: ${e.message}`); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
