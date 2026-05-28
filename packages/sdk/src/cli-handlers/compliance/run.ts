// `mcpverify compliance run [flags]` — the 89-assertion protocol probe.
// Behaviorally identical to the legacy top-level `mcpverify run`; this file
// owns the argv parsing + output formatting that used to live inline in cli.ts.

import { parseArgs } from 'node:util';
import { run } from '../../index.js';
import { McpVerifyClient } from '../../client-class.js';
import type { AuthMode, Mode, TransportKind } from '../../types.js';

export async function runHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:           { type: 'boolean', short: 'h' },
      'api-key':      { type: 'string' },
      'api-url':      { type: 'string' },
      quiet:          { type: 'boolean', short: 'q' },
      server:         { type: 'string',  short: 's' },
      'server-id':    { type: 'string' },
      transport:      { type: 'string',  short: 't' },
      url:            { type: 'string',  short: 'u' },
      mode:           { type: 'string',  short: 'm', default: 'quick' },
      bearer:         { type: 'string' },
      auth:           { type: 'string' },
      scope:          { type: 'string',  multiple: true },
      header:         { type: 'string',  multiple: true, short: 'H' },
      'no-interactive': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  // ----------------------------------------------------------------------
  // --server-id <id> mode: resolve transport / url / command / headers /
  // scopes from a stored server entity. Mutually exclusive with the direct
  // target flags. The encrypted bearer/oauth credentials are NOT pulled
  // down (server-side encryption-at-rest is preserved) — if the stored
  // server's default_auth_kind is 'bearer', the user still passes --bearer.
  // ----------------------------------------------------------------------
  const serverId = values['server-id'] as string | undefined;
  if (serverId) {
    const conflictFlags: string[] = [];
    if (values.transport) conflictFlags.push('--transport');
    if (values.url) conflictFlags.push('--url');
    if (values.server) conflictFlags.push('--server');
    if (conflictFlags.length > 0) {
      console.error(
        `Error: --server-id is mutually exclusive with ${conflictFlags.join(', ')}. ` +
        `Pass either a stored server id OR direct target flags, not both.`,
      );
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

    let stored;
    try {
      stored = await client.servers.get(serverId);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
      if (e.status === 404) { console.error(`Error: server ${serverId} not found (or not yours)`); process.exit(3); }
      if (e.status === 0)   { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
      console.error(`Error: ${e.message ?? String(err)}`);
      process.exit(1);
    }

    // Hydrate the parseArgs values from the stored row so the downstream
    // validation + run() options-shaping treats this like a normal invocation.
    // Guard against assigning undefined — the OSS tsconfig has
    // exactOptionalPropertyTypes:true which forbids it.
    values.transport = stored.transport;
    if (stored.transport === 'stdio') {
      if (stored.command) values.server = stored.command;
    } else {
      if (stored.url) values.url = stored.url;
    }
    // Merge stored default_headers into the -H values (explicit -H wins on
    // collision — process.argv order matters less than user intent).
    if (stored.default_headers) {
      const incoming = (values.header ?? []) as string[];
      const explicitNames = new Set(
        incoming.map((raw) => {
          const i = raw.indexOf(':');
          return i > 0 ? raw.slice(0, i).trim().toLowerCase() : '';
        }),
      );
      const merged = [...incoming];
      for (const [k, v] of Object.entries(stored.default_headers)) {
        if (!explicitNames.has(k.toLowerCase())) merged.push(`${k}: ${v}`);
      }
      values.header = merged;
    }
    if (stored.default_scopes && (!(values.scope as string[] | undefined)?.length)) {
      values.scope = stored.default_scopes;
    }

    if (!values.quiet) {
      const target = stored.transport === 'stdio' ? stored.command : stored.url;
      console.error(`[server-id] Using stored server "${stored.name}" (${stored.transport} → ${target})`);
      if (stored.default_auth_kind === 'bearer' && !values.bearer) {
        console.error(
          `[server-id] Note: this server is registered with default_auth_kind=bearer. ` +
          `The stored token is encrypted at rest and not surfaced to the SDK — ` +
          `pass --bearer "$TOKEN" if your server requires it.`,
        );
      }
    }
  }
  // ----------------------------------------------------------------------

  // Default transport to stdio if nothing was provided/resolved.
  const transport = (values.transport ?? 'stdio') as TransportKind;
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    console.error(`Error: --transport must be one of stdio, http, sse (got "${transport}")`);
    process.exit(2);
  }

  if (transport === 'stdio' && !values.server) {
    console.error('Error: --server is required for stdio transport');
    console.error('  mcpverify compliance run --server "node my-server.js"');
    console.error('  (or use --server-id <id> to reference a registered server)');
    process.exit(2);
  }

  if ((transport === 'http' || transport === 'sse') && !values.url) {
    console.error(`Error: --url is required for ${transport} transport`);
    console.error(`  mcpverify compliance run --transport ${transport} --url https://your-server.example.com/${transport === 'http' ? 'mcp' : 'sse'}`);
    console.error('  (or use --server-id <id> to reference a registered server)');
    process.exit(2);
  }

  const mode = (values.mode ?? 'quick') as Mode;
  if (!['quick', 'standard'].includes(mode)) {
    console.error(`Error: --mode must be quick or standard (got "${mode}")`);
    process.exit(2);
  }

  let auth: AuthMode | undefined;
  if (values.auth !== undefined) {
    if (!['none', 'bearer', 'oauth'].includes(values.auth as string)) {
      console.error(`Error: --auth must be one of none, bearer, oauth (got "${values.auth}")`);
      process.exit(2);
    }
    auth = values.auth as AuthMode;
  }

  if (transport === 'stdio' && (values.bearer || (auth && auth !== 'none'))) {
    console.error('Warning: --bearer and --auth are ignored for stdio transport');
  }

  const headers: Record<string, string> = {};
  for (const raw of (values.header ?? []) as string[]) {
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      console.error(`Error: --header must be "Name: Value" (got "${raw}")`);
      process.exit(2);
    }
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!name || !value) {
      console.error(`Error: --header has empty name or value: "${raw}"`);
      process.exit(2);
    }
    if (name.toLowerCase() === 'authorization' && (values.bearer || auth === 'oauth' || auth === 'bearer')) {
      console.error(`Warning: --header "Authorization: ..." ignored because --bearer/--auth manages this header`);
      continue;
    }
    headers[name] = value;
  }
  if (transport === 'stdio' && Object.keys(headers).length > 0) {
    console.error('Warning: --header is ignored for stdio transport');
  }

  try {
    if (!values.quiet) {
      console.error('MCPVerify — Trust Every Tool. Ship With Confidence.');
      console.error(`Transport: ${transport}`);
      if (transport === 'stdio') console.error(`Server:    ${values.server}`);
      else console.error(`URL:       ${values.url}`);
      console.error(`Mode:      ${mode}`);
      console.error('');
      console.error('Capturing protocol trace...');
    }

    const result = await run({
      transport,
      ...(values.server ? { server: values.server as string } : {}),
      ...(values.url ? { url: values.url as string } : {}),
      mode,
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
      ...(values.bearer ? { bearer: values.bearer as string } : {}),
      ...(auth ? { auth } : {}),
      ...(((values.scope as string[]) ?? []).length > 0 ? { scopes: values.scope as string[] } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(values['no-interactive'] ? { noInteractive: true } : {}),
      verbose: !values.quiet,
    });

    if (!values.quiet) {
      console.error('');
      const s = result.summary;
      console.error(`Run complete: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.warned} warned, ${s.skipped} skipped`);
      console.error('');
      console.error(`Report: ${result.reportUrl}`);
    }

    process.exit(result.summary.failed > 0 ? 1 : 0);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.name === 'ApiError') {
      if (e.status === 0) {
        console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.');
        process.exit(2);
      }
      console.error(`API error (${e.status ?? '?'}): ${e.message}`);
      if (e.status === 401) {
        console.error('Hint: get an API key at https://app.mcpverify.dev/settings/api-keys');
      }
      process.exit(2);
    }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}

function printHelp(): void {
  process.stdout.write(`mcpverify compliance run — capture a fresh trace + ship to cloud for scoring

USAGE
  mcpverify compliance run --transport <kind> [target] [auth] [api-key]

REQUIRED — choose ONE of:

  EITHER (direct flags):
    --transport stdio|http|sse     Transport to your MCP server (default: stdio)
    -s, --server "<command>"       For stdio: the command to spawn (e.g. "node my-server.js")
    -u, --url <url>                For http/sse: the endpoint URL

  OR (use a registered server):
    --server-id <id>               Resolve transport / url / command / default headers
                                   / default scopes from a server you've already
                                   registered via 'mcpverify servers create'.
                                   The encrypted auth credentials are NOT pulled
                                   down (encryption-at-rest preserved) — if the
                                   stored server's default_auth_kind is 'bearer',
                                   still pass --bearer with your token.

AUTH (http/sse only)
  --bearer <token>                   Pre-acquired bearer token (CI-friendly)
  --auth none|bearer|oauth           Force a specific mode. Default: auto (OAuth on 401 + valid metadata + TTY).
  --scope <name>                     OAuth scope. Repeatable.
  -H, --header "Name: Value"        Extra HTTP header. Repeatable.
  --no-interactive                   Disable auto-OAuth even on TTY (use in CI).

CLOUD
  --api-key <key>                    Your MCPVerify cloud key. Default: $MCPVERIFY_API_KEY env var.
  --api-url <url>                    Override the cloud endpoint (testing/dev).

OTHER
  -m, --mode quick|standard          Probe depth. Default: quick.
  -q, --quiet                        Suppress narrative stderr output.
  -h, --help                         Show this message.

EXAMPLES
  mcpverify compliance run --transport stdio --server "node my-server.js"
  mcpverify compliance run --transport http --url https://your-server.com/mcp --bearer "$TOKEN"
  mcpverify compliance run --transport http --url https://oauth-gated.example.com/mcp --auth oauth
  mcpverify compliance run --server-id ddf3571330ed96faa05f6d829524d41c --bearer "$TOKEN"
`);
}
