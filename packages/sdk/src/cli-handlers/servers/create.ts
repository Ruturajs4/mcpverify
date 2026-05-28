// `mcpverify servers create --name X --transport Y --url Z [--header H:V] [--bearer T]`

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

export async function createHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:                { type: 'boolean', short: 'h' },
      'api-key':           { type: 'string' },
      'api-url':           { type: 'string' },
      name:                { type: 'string' },
      description:         { type: 'string' },
      transport:           { type: 'string', short: 't' },
      url:                 { type: 'string', short: 'u' },
      command:             { type: 'string' },
      'env-tag':           { type: 'string' },
      header:              { type: 'string', multiple: true, short: 'H' },
      scope:               { type: 'string', multiple: true },
      'auth-kind':         { type: 'string' },
      'bearer-stdin':      { type: 'boolean' },
      bearer:              { type: 'string' },
      json:                { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify servers create — register a new MCP server entry

USAGE
  mcpverify servers create --name <n> --transport <t> --url <u> [auth + headers]
  mcpverify servers create --name <n> --transport stdio --command <c>

REQUIRED
  --name <n>            Server name (1-128 chars)
  --transport <t>       'stdio' | 'http' | 'sse'
  --url <u>             Target URL (required for http/sse)
  --command <c>         Command to spawn (required for stdio)

OPTIONAL
  --description <d>     Free-form note (max 2000 chars)
  --env-tag <t>         Environment label (e.g. "prod", "staging")
  -H, --header "K: V"   Default header to send on every request (can repeat)
  --scope <s>           OAuth scope to request (can repeat)
  --auth-kind <k>       'none' | 'bearer' | 'oauth'
  --bearer <token>      Bearer token value (visible in argv — prefer --bearer-stdin)
  --bearer-stdin        Read bearer token from stdin

EXAMPLE
  echo "$TOKEN" | mcpverify servers create \\
    --name "Prod MCP" --transport http --url https://api.example.com/mcp \\
    --auth-kind bearer --bearer-stdin -H "X-Tenant: acme"
`);
    return;
  }

  const name = values.name as string | undefined;
  const transport = values.transport as string | undefined;
  if (!name || !transport) {
    console.error('Error: --name and --transport are required');
    process.exit(2);
  }
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    console.error("Error: --transport must be 'stdio', 'http', or 'sse'");
    process.exit(2);
  }
  if (transport === 'stdio' && !values.command) {
    console.error('Error: --command is required when --transport=stdio'); process.exit(2);
  }
  if (transport !== 'stdio' && !values.url) {
    console.error(`Error: --url is required when --transport=${transport}`); process.exit(2);
  }

  const headers: Record<string, string> = {};
  for (const raw of (values.header ?? []) as string[]) {
    const i = raw.indexOf(':');
    if (i <= 0) { console.error(`Error: -H must be "Name: value" (got "${raw}")`); process.exit(2); }
    headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }

  let bearer: string | undefined;
  if (values['bearer-stdin']) bearer = await readStdinValue();
  else if (values.bearer) bearer = values.bearer as string;

  const authKind = values['auth-kind'] as 'none' | 'bearer' | 'oauth' | undefined;
  if (authKind === 'bearer' && !bearer) {
    console.error('Error: --auth-kind=bearer requires --bearer-stdin or --bearer <token>');
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
    const created = await client.servers.create({
      name,
      transport: transport as 'stdio' | 'http' | 'sse',
      ...(values.description ? { description: values.description as string } : {}),
      ...(values.url ? { url: values.url as string } : {}),
      ...(values.command ? { command: values.command as string } : {}),
      ...(values['env-tag'] ? { envTag: values['env-tag'] as string } : {}),
      ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
      ...((values.scope as string[] | undefined)?.length ? { defaultScopes: values.scope as string[] } : {}),
      ...(authKind ? { defaultAuthKind: authKind } : {}),
      ...(bearer ? { defaultAuthBearer: bearer } : {}),
    });
    if (values.json) { emitJson(created); return; }
    process.stdout.write(`Created server "${created.name}" (id ${created.id})\n`);
    process.stdout.write(`Transport: ${created.transport} → ${created.url ?? created.command}\n`);
    process.stdout.write(`Probe it: mcpverify servers probe ${created.id}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 409) { console.error(`Error: server name "${name}" already taken`); process.exit(3); }
    if (e.status === 400) { console.error(`Error: ${e.message}`); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
