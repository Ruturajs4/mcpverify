// `mcpverify diagnose [--transport <kind>] --url <url>` — 5-layer probe.
// Behaviorally identical to the legacy top-level `mcpverify diagnose`.

import { parseArgs } from 'node:util';
import {
  runDiagnose,
  DiagnoseApiError,
  DIAGNOSE_LAYER_ORDER,
  type DiagnoseTarget,
  type DiagnoseLayer,
} from '../diagnose.js';
import type { TransportKind } from '../types.js';

export async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:           { type: 'boolean', short: 'h' },
      'api-key':      { type: 'string' },
      'api-url':      { type: 'string' },
      quiet:          { type: 'boolean', short: 'q' },
      transport:      { type: 'string',  short: 't', default: 'http' },
      url:            { type: 'string',  short: 'u' },
      bearer:         { type: 'string' },
      'auth-fixture': { type: 'string' },
      header:         { type: 'string',  multiple: true, short: 'H' },
      'no-color':     { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify diagnose — 5-layer connectivity probe (DNS → TLS → init → auth → tools/list)

USAGE
  mcpverify diagnose --transport <kind> --url <url> [auth] [--api-key <key>]

  Runs anonymously if no --api-key / MCPVERIFY_API_KEY is set (rate-limited
  to 5 calls / 5 min / IP). Authenticated mode unlocks fixture-based auth
  and higher quotas — grab an invite at https://mcpverify.dev/invite.

REQUIRED
  -t, --transport http|sse        Transport (stdio not supported via cloud — run locally)
  -u, --url <url>                 MCP server endpoint URL

AUTH (optional — diagnose runs server-side, only accepts fixture references)
  --auth-fixture <name>           Reference an existing fixture as bearer (requires --api-key)
  -H "Name: <fixtureName>"        Reference a fixture as a custom header (requires --api-key)

CLOUD
  --api-key <key>                 Your MCPVerify cloud key. Default: $MCPVERIFY_API_KEY env var.
                                  Omit to run anonymously (no signup required).
  --api-url <url>                 Override the cloud endpoint.

OTHER
  --no-color                      Disable ANSI color output.
  -q, --quiet                     Suppress stderr table (stdout JSON line still printed).
`);
    return;
  }

  const transport = (values.transport ?? 'http') as TransportKind;
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    console.error(`Error: --transport must be one of stdio, http, sse (got "${transport}")`);
    process.exit(2);
  }

  const target: DiagnoseTarget = { transport };
  if (transport === 'stdio') {
    console.error(
      'Error: `mcpverify diagnose --transport stdio` is local-only and not supported by the cloud.\n' +
        '  Expose your stdio server over http/sse and re-run.',
    );
    process.exit(1);
  } else {
    if (!values.url) {
      console.error(`Error: --url is required for ${transport} transport`);
      process.exit(2);
    }
    target.url = values.url as string;
  }

  if (values.bearer) {
    console.error(
      'Error: --bearer (literal token) is not supported by diagnose. ' +
      'Diagnose runs in the cloud and reads fixtures by name to keep tokens out of CLI args.',
    );
    console.error('  Use --auth-fixture <name> with a fixture you created via the web app.');
    process.exit(2);
  }
  if (values['auth-fixture']) {
    target.auth = { type: 'bearer', fixture: values['auth-fixture'] as string };
  }
  const headers = (values.header ?? []) as string[];
  if (headers.length > 0) {
    if (headers.length > 1) {
      console.error('Error: diagnose only accepts a single -H "Name: fixture-name" header.');
      process.exit(2);
    }
    const raw = headers[0]!;
    const colon = raw.indexOf(':');
    if (colon <= 0) {
      console.error(`Error: -H must be "Name: fixture-name" (got "${raw}")`);
      process.exit(2);
    }
    const name = raw.slice(0, colon).trim();
    const fixture = raw.slice(colon + 1).trim();
    if (!name || !fixture) {
      console.error(`Error: -H has empty name or fixture: "${raw}"`);
      process.exit(2);
    }
    if (target.auth) {
      console.error('Error: cannot combine --auth-fixture with -H. Pick one.');
      process.exit(2);
    }
    target.auth = { type: 'header', name, fixture };
  }

  const useColor = process.stdout.isTTY === true && !values['no-color'];
  const c = makeColor(useColor);

  const hasKey = !!(values['api-key'] || process.env['MCPVERIFY_API_KEY']);

  if (!values.quiet) {
    console.error(`[diagnose] target=${values.url}`);
    if (!hasKey) {
      console.error(
        '[diagnose] running anonymously (rate-limited 5/5min/IP). ' +
        'For unlimited authenticated runs, grab an invite at https://mcpverify.dev/invite',
      );
    }
  }

  let result;
  try {
    result = await runDiagnose({
      target,
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) {
    if (err instanceof DiagnoseApiError) {
      if (err.status === 0) {
        // Includes the anonymous-mode-precheck "you can't use --auth-fixture
        // without --api-key" case AND real fetch timeouts. The error message
        // is descriptive enough — just print it.
        console.error(`Error: ${err.message}`);
        process.exit(2);
      }
      if (err.status === 429) {
        console.error(`Rate limit (${err.status}): ${err.message}`);
        console.error(
          'Hint: anonymous diagnose is limited. Grab an invite at https://mcpverify.dev/invite ' +
          'for an API key + unlimited runs.',
        );
        process.exit(2);
      }
      console.error(`API error (${err.status}) at ${err.endpoint}: ${err.message}`);
      if (err.status === 401) {
        console.error('Hint: API key rejected. Confirm MCPVERIFY_API_KEY is set and valid.');
      }
      process.exit(2);
    }
    console.error(`Error: ${(err as Error).message ?? String(err)}`);
    process.exit(2);
  }

  for (const name of DIAGNOSE_LAYER_ORDER) {
    const layer = result.layers.find((l) => l.name === name);
    if (!layer) continue;
    if (!values.quiet) process.stderr.write(`  ${renderLayer(layer, c)}\n`);
  }
  process.stdout.write(JSON.stringify(result) + '\n');

  const failed = result.layers.some((l) => l.status === 'fail');
  process.exit(failed ? 1 : 0);
}

interface ColorPalette {
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  gray: (s: string) => string;
}
function makeColor(enabled: boolean): ColorPalette {
  if (!enabled) {
    return { green: (s) => s, red: (s) => s, yellow: (s) => s, gray: (s) => s };
  }
  return {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    gray: (s) => `\x1b[90m${s}\x1b[0m`,
  };
}

function renderLayer(layer: DiagnoseLayer, c: ColorPalette): string {
  const symbol = layer.status === 'pass' ? c.green('+') : layer.status === 'fail' ? c.red('x') : c.yellow('-');
  const name = layer.name.padEnd(13, ' ');
  const summary = layerSummary(layer);
  const latency = layer.latencyMs != null ? `${layer.latencyMs}ms` : '';
  return `${symbol} ${name} ${summary.padEnd(40, ' ')} ${c.gray(latency)}`;
}

function layerSummary(layer: DiagnoseLayer): string {
  if (layer.status === 'skip') return layer.error ?? 'skipped';
  if (layer.status === 'fail') return (layer.error ?? 'failed').slice(0, 40);
  const extras = (layer.extras ?? {}) as Record<string, unknown>;
  switch (layer.name) {
    case 'dns-tcp':
      return typeof extras['resolvedIp'] === 'string'
        ? `ok (${String(extras['resolvedIp'])}:${String(extras['port'])})`
        : 'ok';
    case 'tls':
      return typeof extras['protocol'] === 'string' ? `handshake ok (${String(extras['protocol'])})` : 'handshake ok';
    case 'initialize': {
      const info = extras['serverInfo'] as { name?: string; version?: string } | undefined;
      const name = info?.name ?? '?';
      const ver = info?.version ?? '?';
      return `serverInfo.name="${name}/${ver}"`;
    }
    case 'auth': {
      const www = extras['wwwAuthenticate'];
      if (typeof www === 'string' && /bearer/i.test(www)) {
        const status = extras['mcpProbeStatus'];
        return `${status ?? '401'} → ${String(www).slice(0, 30)}`;
      }
      const meta = extras['oauthMetadata'] as { status?: number } | undefined;
      if (meta?.status === 200) return 'OAuth metadata 200';
      if (meta?.status === 404) return 'no OAuth advertised';
      return 'ok';
    }
    case 'tools-list':
      return `${String(extras['toolCount'] ?? 0)} tools`;
    default:
      return 'ok';
  }
}
