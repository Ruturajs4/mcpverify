// T-147 — SDK-side diagnose client.
//
// Posts the diagnose target to the cloud (`POST /api/v1/studio/diagnose`)
// and returns the layer array. The cloud is intentionally the executor here
// — the most common diagnose use case is "I deployed MCPVerify Cloud and I
// need to know whether it can reach my private MCP server". A local-only
// diagnose would test the user's laptop, not the cloud.
//
// Zero new runtime dependencies — native fetch only. Same pattern as studio.ts.

// Note: resolveApiKey (throws on miss) is intentionally NOT used here. Diagnose
// supports an anonymous mode via the public endpoint when no key is present.

const DEFAULT_API_URL = 'https://api.mcpverify.dev';

export type DiagnoseTransport = 'stdio' | 'http' | 'sse';

export interface DiagnoseAuthBearer {
  type: 'bearer';
  fixture: string;
}
export interface DiagnoseAuthHeader {
  type: 'header';
  name: string;
  fixture: string;
}

export interface DiagnoseTarget {
  transport: DiagnoseTransport;
  url?: string;
  command?: string;
  auth?: DiagnoseAuthBearer | DiagnoseAuthHeader;
}

export type DiagnoseLayerName = 'dns-tcp' | 'tls' | 'initialize' | 'auth' | 'tools-list';
export type DiagnoseLayerStatus = 'pass' | 'fail' | 'skip';

export interface DiagnoseLayer {
  name: DiagnoseLayerName;
  status: DiagnoseLayerStatus;
  latencyMs?: number;
  error?: string;
  extras?: Record<string, unknown>;
}

export interface DiagnoseResult {
  layers: DiagnoseLayer[];
}

export interface DiagnoseClientOptions {
  target: DiagnoseTarget;
  apiKey?: string;
  apiUrl?: string;
}

export class DiagnoseApiError extends Error {
  constructor(public readonly status: number, public readonly endpoint: string, message: string) {
    super(message);
    this.name = 'DiagnoseApiError';
  }
}

// Red Flags Bundle Phase E (RF-3 follow-up) — bare-fetch timeout. The single
// fetch() in this module needs the same status=0 semantics as CloudClient so
// the CLI handler's `if (err.status === 0)` branch fires on a hung host.
const DIAGNOSE_DEFAULT_TIMEOUT_MS = 30_000;

function diagnoseTimeoutMs(): number {
  const raw = process.env['MCPVERIFY_API_TIMEOUT_MS'];
  if (!raw) return DIAGNOSE_DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DIAGNOSE_DEFAULT_TIMEOUT_MS;
}

/**
 * Send a diagnose request to the cloud. Always returns a five-layer result
 * (matching `LAYER_ORDER`). Network/auth errors are thrown as DiagnoseApiError.
 *
 * Two paths, picked by whether an API key is available:
 *   - With key:    POST /api/v1/studio/diagnose with `Authorization: Bearer …`
 *                  — supports `target.auth` fixture references, no rate limit
 *                    beyond the global API one.
 *   - Without key: POST /api/v1/public/diagnose (anonymous, IP-rate-limited
 *                  5 calls / 5 min). Fixture references are rejected by the
 *                  server. This path exists so first-time visitors who copy
 *                  the CLI snippet from a Reddit thread / landing page get a
 *                  working result without signing up.
 */
export async function runDiagnose(opts: DiagnoseClientOptions): Promise<DiagnoseResult> {
  // Resolve key WITHOUT throwing on miss — undefined means "run anonymous".
  const apiKey = opts.apiKey ?? process.env['MCPVERIFY_API_KEY'];
  const apiUrl = (opts.apiUrl ?? process.env['MCPVERIFY_API_URL'] ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const isAnonymous = !apiKey;

  // Anonymous mode forbids fixture refs — the server has no user-scoped
  // fixture table to look them up in, and the public route's schema rejects
  // the field outright. Surface the fail-fast message here so the CLI can
  // print a usable hint instead of a 400 from the cloud.
  if (isAnonymous && opts.target.auth) {
    throw new DiagnoseApiError(
      0,
      'anonymous-mode-precheck',
      'Anonymous diagnose (no MCPVERIFY_API_KEY) cannot use --auth-fixture or -H. ' +
        'Either drop the auth flags, or grab an invite at https://mcpverify.dev/invite ' +
        'and rerun with --api-key <your-key>.',
    );
  }

  const endpoint = isAnonymous
    ? `${apiUrl}/api/v1/public/diagnose`
    : `${apiUrl}/api/v1/studio/diagnose`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'mcpverify-sdk-diagnose/0.0.1',
  };
  if (!isAnonymous) headers['Authorization'] = `Bearer ${apiKey}`;

  const ms = diagnoseTimeoutMs();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target: opts.target }),
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new DiagnoseApiError(
        0,
        endpoint,
        `Request timed out after ${Math.round(ms / 1000)}s. Check MCPVERIFY_API_URL or your network.`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.text();
      if (body) {
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) msg = parsed.error;
          else msg = body.slice(0, 500);
        } catch {
          msg = body.slice(0, 500);
        }
      }
    } catch {
      /* swallow */
    }
    throw new DiagnoseApiError(res.status, endpoint, msg);
  }

  const data = (await res.json()) as DiagnoseResult;
  if (!data || !Array.isArray(data.layers)) {
    throw new DiagnoseApiError(res.status, endpoint, 'Response missing layers array');
  }
  return data;
}

export const DIAGNOSE_LAYER_ORDER: DiagnoseLayerName[] = [
  'dns-tcp',
  'tls',
  'initialize',
  'auth',
  'tools-list',
];
