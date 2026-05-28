// Public SDK entry point. Programmatic API for embedding mcpverify in CI scripts.
//
//   import { run } from '@mcp-verify/sdk';
//
//   // stdio
//   const result = await run({ server: 'node dist/server.js', apiKey: process.env.MCPV_KEY });
//
//   // HTTP, pre-acquired bearer token (CI)
//   await run({ transport: 'http', url: 'https://my-server.example.com/mcp', bearer: process.env.MCP_TOKEN });
//
//   // HTTP, full OAuth 2.1 flow (interactive — opens a browser)
//   await run({ transport: 'http', url: 'https://my-server.example.com/mcp', auth: 'oauth', scopes: ['read', 'write'] });

import { StdioTransport, StreamableHttpTransport, SseTransport, type Transport } from './transport.js';
import { runProbeSequence } from './probe.js';
import { CloudClient, resolveApiKey } from './client.js';
import { getOAuthToken, probeAuthSurface, type AuthProbeResult } from './oauth.js';
import type {
  RunOptions,
  RunResult,
  TraceAuthData,
  TraceBundle,
  TraceTasksProbes,
  TraceTransportProbes,
  TransportKind,
} from './types.js';

const SDK_VERSION = '0.1.0';

export type { Mode, AuthMode, RunOptions, RunResult, ProtocolMessage, TraceBundle, TransportKind } from './types.js';
export { ApiError } from './client.js';
export { McpVerifyClient } from './client-class.js';
export type {
  McpVerifyClientOptions,
  ComplianceRunSummary,
  ComplianceRunDetail,
  SuiteSummary,
  ServerSummary,
  CaseRunResult,
} from './client-class.js';
export { StdioTransport, StreamableHttpTransport, SseTransport } from './transport.js';
export type { Transport } from './transport.js';
// Lower-level building blocks — used by app.mcpverify.dev's cloud-runner endpoint
// (T-175) to drive a probe in-process without forcing an HTTP loop through
// /api/v1/runs/score. Safe to expose: they contain NO scoring logic.
export { runProbeSequence } from './probe.js';
export { probeAuthSurface } from './oauth.js';
export type { AuthProbeResult } from './oauth.js';
export { getOAuthToken, discoverAuthServer, registerClient, generatePKCE } from './oauth.js';
export type { OAuthToken, AuthServerMetadata } from './oauth.js';
export { runStudioSuite, StudioApiError, StudioSuiteFileError } from './studio.js';
export type {
  StudioRunOptions,
  StudioRunResult,
  StudioCaseReport,
  StudioSuiteFile,
  StudioSuiteCaseInput,
} from './studio.js';
// suite-runner.ts removed in 0.7.0 (T-184). Local suite execution now runs
// step-by-step through the cloud /evaluate endpoint — see cloud-eval-runner
// (added later in this PR). Old runSuiteLocal + Suite*Error exports gone.
export { runDiagnose, DiagnoseApiError, DIAGNOSE_LAYER_ORDER } from './diagnose.js';
export type {
  DiagnoseTransport,
  DiagnoseAuthBearer,
  DiagnoseAuthHeader,
  DiagnoseTarget,
  DiagnoseLayerName,
  DiagnoseLayerStatus,
  DiagnoseLayer,
  DiagnoseResult,
  DiagnoseClientOptions,
} from './diagnose.js';

export async function run(opts: RunOptions): Promise<RunResult> {
  const transportKind: TransportKind = opts.transport ?? 'stdio';
  const verbose = opts.verbose ?? false;

  // Validate the inputs that vary by transport.
  let target: string;
  switch (transportKind) {
    case 'stdio':
      if (!opts.server?.trim()) {
        throw new Error('opts.server is required for stdio transport (the command to launch your MCP server)');
      }
      target = opts.server;
      break;
    case 'http':
      if (!opts.url?.trim()) {
        throw new Error('opts.url is required for http transport (the /mcp endpoint URL)');
      }
      target = opts.url;
      break;
    case 'sse':
      if (!opts.url?.trim()) {
        throw new Error('opts.url is required for sse transport (the GET /sse endpoint URL)');
      }
      target = opts.url;
      break;
    default:
      throw new Error(`Unknown transport: ${String(transportKind)}`);
  }

  // Probe the auth surface BEFORE any auth happens so we capture the unauthenticated baseline.
  // Skipped for stdio (no HTTP surface to probe).
  let authProbe: AuthProbeResult | undefined;
  if (transportKind === 'http' || transportKind === 'sse') {
    if (verbose) console.error(`[mcpverify] probing auth surface at ${target}...`);
    try {
      authProbe = await probeAuthSurface(target);
    } catch (err) {
      if (verbose) console.error(`[mcpverify] auth probe failed (continuing): ${(err as Error).message}`);
    }
  }

  // Resolve an OAuth bearer token if needed.
  // Per MCP authorization spec §"Authorization Flow > Overview":
  //   "Clients initiate the OAuth 2.1 IETF DRAFT authorization flow after receiving
  //    the HTTP 401 Unauthorized."
  // So when the auth probe returned 401 + valid metadata and we're in an interactive
  // terminal, we auto-trigger the OAuth flow rather than skipping. The user can opt
  // out with --auth none or --no-interactive.
  const bearer = await resolveBearerToken(opts, transportKind, target, authProbe, verbose);

  // Pre-upload hint: if the auth probe came back 401 and we couldn't auto-auth,
  // tell the user what to expect from the report.
  if (
    verbose &&
    (transportKind === 'http' || transportKind === 'sse') &&
    authProbe?.unauthenticated?.status === 401 &&
    !bearer
  ) {
    console.error('[mcpverify] Server requires authentication (HTTP 401 from auth probe).');
    console.error('[mcpverify] Without credentials, only the 4 AUTH-* assertions will score.');
    console.error('[mcpverify] Continuing — your report will explain how to re-run with auth.');
  }

  // TRANS-001/002/003 — HTTP-method probes for Streamable HTTP. Captures
  // GET / OPTIONS / DELETE on the MCP endpoint so the assertions can
  // score conformance to the Streamable HTTP transport spec. Runs AFTER
  // bearer resolution so authenticated production servers (GitHub
  // Copilot, etc.) see the credential and respond with their real
  // behavior instead of 401. OPTIONS stays unauthenticated by spec —
  // CORS preflight forbids credentials (Fetch §3.2.2).
  let transportProbes: TraceTransportProbes | undefined;
  if (transportKind === 'http') {
    transportProbes = await captureTransportProbes(target, bearer, opts.headers);
  }

  // Build the transport.
  let transport: Transport;
  switch (transportKind) {
    case 'stdio':
      transport = new StdioTransport(opts.server!);
      break;
    case 'http':
      transport = new StreamableHttpTransport(opts.url!, bearer, opts.headers);
      break;
    case 'sse':
      transport = new SseTransport(opts.url!, bearer, opts.headers);
      break;
  }

  const apiKey = resolveApiKey(opts.apiKey);
  const client = new CloudClient(apiKey, opts.apiUrl);
  const mode = opts.mode ?? 'quick';

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  await transport.start();

  let shutdown: { exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null };
  try {
    if (verbose) console.error(`[mcpverify] running ${mode} probe (${transportKind}) against: ${target}`);
    await runProbeSequence(transport, mode);
  } finally {
    shutdown = await transport.stop();
  }

  // Build the auth trace data — only when the auth probe ran (i.e. HTTP/SSE).
  // For stdio we leave `auth` undefined entirely so the cloud classifies as 'not-applicable'.
  let authTrace: TraceAuthData | undefined;
  if (authProbe) {
    authTrace = authProbeToTraceData(authProbe);
    authTrace.authProvided = !!bearer;
  }

  // TASK-001..004 — Tasks-capability probes. Synthesized from the trace
  // after the main probe sequence completes. Only populated when the
  // initialize response declared `capabilities.tasks`.
  const tasksProbes = extractTasksProbes(transport.getMessages());

  const trace: TraceBundle = {
    sdkVersion: SDK_VERSION,
    serverCommand: target,
    transport: transportKind,
    mode,
    startedAt,
    durationMs: Date.now() - startMs,
    messages: transport.getMessages(),
    stderr: transport.getStderr(),
    shutdown,
    ...(authTrace ? { auth: authTrace } : {}),
    ...(transportProbes ? { transportProbes } : {}),
    ...(tasksProbes ? { tasksProbes } : {}),
  };

  if (verbose) {
    console.error(`[mcpverify] captured ${trace.messages.length} protocol messages, ${trace.stderr.length} stderr chunk(s)`);
    console.error(`[mcpverify] uploading trace to ${opts.apiUrl ?? 'mcpverify.dev'}...`);
  }

  return await client.submitTrace(trace);
}

/**
 * TRANS-001/002/003 — Issue GET / OPTIONS / DELETE probes against the MCP
 * endpoint with short timeouts. Errors collapse to undefined for that
 * method so a partial network failure doesn't lose the other probes' data.
 *
 * Auth handling:
 *  - GET and DELETE carry the user's bearer + extra headers so authenticated
 *    servers respond with their real session-termination / SSE behavior
 *    instead of a generic 401. Previously these probes were unauthenticated,
 *    which meant TRANS-001/003 on a real cloud MCP server always warned
 *    "auth-gated; can't verify" even though we had the credential in hand.
 *  - OPTIONS deliberately stays unauthenticated. Per Fetch §3.2.2 the
 *    browser MUST NOT include credentials on the CORS preflight, so testing
 *    OPTIONS with auth would measure server behavior the browser will never
 *    actually see. A server that requires auth on OPTIONS is broken FOR
 *    browser clients regardless of whether we have a token.
 */
async function captureTransportProbes(
  target: string,
  bearer: string | undefined,
  extraHeaders: Record<string, string> | undefined,
): Promise<TraceTransportProbes | undefined> {
  const authedHeaders: Record<string, string> = {};
  if (bearer) authedHeaders['Authorization'] = `Bearer ${bearer}`;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      // User-supplied headers don't overwrite the bearer we just set.
      if (k.toLowerCase() === 'authorization' && bearer) continue;
      authedHeaders[k] = v;
    }
  }

  const probe = async (
    method: 'GET' | 'OPTIONS' | 'DELETE',
    timeoutMs: number,
  ): Promise<{ status: number; headers: Headers; bodyText?: string } | undefined> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // OPTIONS preflight: no credentials per CORS spec.
      const headers = method === 'OPTIONS' ? undefined : authedHeaders;
      const res = await fetch(target, {
        method,
        signal: ac.signal,
        ...(headers ? { headers } : {}),
      });
      // Read up to 256 bytes for DELETE body inspection; drain otherwise.
      let bodyText: string | undefined;
      if (method === 'DELETE') {
        try {
          const text = await res.text();
          bodyText = text.slice(0, 256);
        } catch {
          /* swallow */
        }
      } else {
        try { await res.text(); } catch { /* drain */ }
      }
      return {
        status: res.status,
        headers: res.headers,
        ...(bodyText !== undefined ? { bodyText } : {}),
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const corsOf = (h: Headers): string[] => {
    const out: string[] = [];
    h.forEach((_, name) => {
      if (name.toLowerCase().startsWith('access-control-')) out.push(name);
    });
    return out;
  };
  const [g, o, d] = await Promise.all([
    probe('GET', 5_000),
    probe('OPTIONS', 5_000),
    probe('DELETE', 5_000),
  ]);
  const result: TraceTransportProbes = {};
  if (g) {
    result.get = {
      status: g.status,
      ...(g.headers.get('content-type') ? { contentType: g.headers.get('content-type')! } : {}),
      corsHeaders: corsOf(g.headers),
    };
  }
  if (o) {
    result.options = {
      status: o.status,
      corsHeaders: corsOf(o.headers),
    };
  }
  if (d) {
    let hasJsonRpcErrorEnvelope: boolean | undefined;
    if (d.bodyText) {
      try {
        const parsed = JSON.parse(d.bodyText) as Record<string, unknown>;
        const err = parsed['error'] as Record<string, unknown> | undefined;
        hasJsonRpcErrorEnvelope = !!err && typeof err['code'] === 'number';
      } catch {
        hasJsonRpcErrorEnvelope = false;
      }
    }
    result.delete = {
      status: d.status,
      ...(d.bodyText ? { bodyText: d.bodyText } : {}),
      ...(hasJsonRpcErrorEnvelope !== undefined ? { hasJsonRpcErrorEnvelope } : {}),
    };
  }
  // Return undefined when none of the three probes succeeded — keeps the
  // trace bundle clean and the assertions skip with probe-gap.
  return result.get || result.options || result.delete ? result : undefined;
}

/**
 * TASK-001..004 — Synthesize Tasks-capability probe data from the captured
 * trace. Reads the initialize response to detect `capabilities.tasks`, and
 * if present, scans the trace for tools/call exchanges that elicited a
 * task envelope plus the matching tasks/get exchanges. Does NOT issue new
 * probes — this runs after the main probe sequence finishes; the SDK's
 * runProbeSequence is responsible for emitting the actual probe traffic
 * (see packages/sdk/src/probe.ts where tasks lifecycle calls are added).
 */
function extractTasksProbes(messages: { direction: 'in' | 'out'; payload: Record<string, unknown> }[]):
  TraceTasksProbes | undefined {
  // Find the initialize response and check capabilities.tasks.
  const initOut = messages.find(
    (m) => m.direction === 'out' && m.payload['method'] === 'initialize',
  );
  if (!initOut) return undefined;
  const initId = initOut.payload['id'];
  const initIn = messages.find((m) => m.direction === 'in' && m.payload['id'] === initId);
  if (!initIn) return undefined;
  const result = (initIn.payload['result'] ?? {}) as Record<string, unknown>;
  const caps = (result['capabilities'] ?? {}) as Record<string, unknown>;
  const tasksCap = caps['tasks'];
  if (!tasksCap || typeof tasksCap !== 'object') return undefined;

  const probes: TraceTasksProbes = { capabilityDeclared: true };

  // Find a tools/call response that carries taskId + status (task creation).
  // The SDK probe sequence sends a tools/call with id 'task-create-probe'
  // for the first listed tool when capabilities.tasks is declared.
  const createOut = messages.find(
    (m) => m.direction === 'out' && m.payload['id'] === 'task-create-probe',
  );
  if (createOut) {
    const createIn = messages.find(
      (m) => m.direction === 'in' && m.payload['id'] === 'task-create-probe',
    );
    if (createIn) {
      const r = ((createIn.payload['result'] ?? {}) as Record<string, unknown>);
      const taskCreated: TraceTasksProbes['taskCreated'] = {};
      if (typeof r['taskId'] === 'string') taskCreated.taskId = r['taskId'] as string;
      if (typeof r['status'] === 'string') taskCreated.status = r['status'] as string;
      probes.taskCreated = taskCreated;
    }
  }

  // tasks/get with id 'task-get-probe' and 'task-get-probe-2'.
  const fetchIn = messages.find(
    (m) => m.direction === 'in' && m.payload['id'] === 'task-get-probe',
  );
  if (fetchIn) {
    const r = ((fetchIn.payload['result'] ?? {}) as Record<string, unknown>);
    const taskFetched: TraceTasksProbes['taskFetched'] = {};
    if (typeof r['taskId'] === 'string') taskFetched.taskId = r['taskId'] as string;
    if (typeof r['status'] === 'string') taskFetched.status = r['status'] as string;
    probes.taskFetched = taskFetched;
  }
  const repollIn = messages.find(
    (m) => m.direction === 'in' && m.payload['id'] === 'task-get-probe-2',
  );
  if (repollIn) {
    const r = ((repollIn.payload['result'] ?? {}) as Record<string, unknown>);
    const taskRepolled: TraceTasksProbes['taskRepolled'] = {};
    if (typeof r['status'] === 'string') taskRepolled.status = r['status'] as string;
    probes.taskRepolled = taskRepolled;
  }

  return probes;
}

function authProbeToTraceData(probe: AuthProbeResult): TraceAuthData {
  const trace: TraceAuthData = {};
  if (probe.unauthenticated) trace.unauthenticated = probe.unauthenticated;
  if (probe.metadataEndpoint) {
    trace.metadataEndpoint = {
      status: probe.metadataEndpoint.status,
      body: probe.metadataEndpoint.body as Record<string, unknown> | null,
      ...(probe.metadataEndpoint.contentType ? { contentType: probe.metadataEndpoint.contentType } : {}),
    };
  }
  if (probe.defaultEndpoints) trace.defaultEndpoints = probe.defaultEndpoints;
  return trace;
}

/**
 * Decide what (if anything) to put in the Authorization header.
 *
 *  Resolution order (first match wins):
 *  1. stdio → undefined (no auth)
 *  2. opts.bearer / MCPVERIFY_BEARER → static token (CI-friendly)
 *  3. opts.auth === 'none' → undefined (skip auth even when server requires it)
 *  4. opts.auth === 'oauth' → force OAuth 2.1 + PKCE flow (errors if no browser)
 *  5. AUTO: server returned 401 + has RFC 8414 metadata + interactive TTY → run OAuth
 *  6. Fallback → undefined (skip; classifier will mark auth-required-no-credentials)
 *
 *  Auto-OAuth (case 5) is the spec-mandated default per MCP authorization §"Authorization Flow":
 *  "Clients initiate the OAuth 2.1 IETF DRAFT authorization flow after receiving HTTP 401."
 *  The SDK auto-detects non-TTY (CI) and skips auto-OAuth there to avoid blocking the run.
 *  Users can opt out interactively with --auth none or --no-interactive.
 */
async function resolveBearerToken(
  opts: RunOptions,
  transport: TransportKind,
  target: string,
  authProbe: AuthProbeResult | undefined,
  verbose: boolean,
): Promise<string | undefined> {
  if (transport === 'stdio') return undefined;

  // 1. Static bearer wins over everything (CI uses this).
  const staticToken = opts.bearer ?? process.env['MCPVERIFY_BEARER'];
  if (staticToken) return staticToken;

  // 2. Explicit opt-out: never auth.
  if (opts.auth === 'none') return undefined;

  // 3. Explicit bearer mode without a token is a misconfiguration — fail loudly.
  if (opts.auth === 'bearer') {
    throw new Error('auth=bearer requires opts.bearer or MCPVERIFY_BEARER env var');
  }

  // 4. Forced OAuth — try regardless of probe results.
  if (opts.auth === 'oauth') {
    if (verbose) console.error(`[mcpverify] auth=oauth — running OAuth 2.1 + PKCE flow against ${target}`);
    const token = await getOAuthToken(target, opts.scopes);
    return token.access_token;
  }

  // 5. AUTO: spec-mandated default. Trigger OAuth on 401 + metadata + interactive context.
  const probeStatus = authProbe?.unauthenticated?.status;
  const metadata = authProbe?.metadataEndpoint?.body;
  const hasUsableMetadata = !!metadata?.authorization_endpoint && !!metadata?.token_endpoint;
  const isInteractive = process.stdout.isTTY === true && !opts.noInteractive;

  if (probeStatus === 401 && hasUsableMetadata && isInteractive) {
    if (verbose) {
      console.error('[mcpverify] Server requires authentication (HTTP 401).');
      console.error('[mcpverify] Auto-initiating OAuth 2.1 + PKCE flow per MCP spec...');
      console.error('[mcpverify] (To skip auth, pass --auth none. For static token, pass --bearer.)');
    }
    try {
      const token = await getOAuthToken(target, opts.scopes);
      if (verbose) console.error('[mcpverify] OAuth flow complete — running probe with credentials.');
      return token.access_token;
    } catch (err) {
      if (verbose) console.error(`[mcpverify] OAuth flow failed: ${(err as Error).message}`);
      console.error('[mcpverify] Falling back to unauthenticated probe — auth-* assertions will still score.');
      return undefined;
    }
  }

  // 6. Skip auth — classifier will produce auth-required-no-credentials and the report explains.
  return undefined;
}
