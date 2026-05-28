// SDK public types. Deliberately small — the moat lives in the cloud, not in this package.

export type Mode = 'quick' | 'standard';

/**
 * Transport used to talk to the user's MCP server.
 *  - `stdio`: spawn a local process and exchange JSON-RPC over stdio
 *  - `http`:  Streamable HTTP (MCP 2025-03-26) — single /mcp endpoint
 *  - `sse`:   Legacy HTTP+SSE (MCP 2024-11-05) — GET /sse + POST message-url
 */
export type TransportKind = 'stdio' | 'http' | 'sse';

/**
 * How the SDK should authorize against the user's MCP server.
 *  - 'none'   : send no Authorization header (default)
 *  - 'bearer' : use opts.bearer as a static OAuth 2.1 access token (CI-friendly)
 *  - 'oauth'  : run the full OAuth 2.1 + PKCE + DCR flow on first 401 (interactive)
 */
export type AuthMode = 'none' | 'bearer' | 'oauth';

export interface RunOptions {
  /** Shell command to launch the MCP server, e.g. "node dist/server.js". Required for stdio. */
  server?: string;
  /** Endpoint URL — required when transport is http or sse. */
  url?: string;
  /** Which transport to use. Default: 'stdio'. */
  transport?: TransportKind;
  /** Test mode — quick (critical only) or standard (full Phase 1 suite). */
  mode?: Mode;
  /** API key for mcpverify.dev. Defaults to MCPVERIFY_API_KEY env var. */
  apiKey?: string;
  /** Override the API endpoint (mostly for self-hosted enterprise installs). */
  apiUrl?: string;
  /** When true, prints assertion results to stdout as they arrive. Default: true in CLI, false in programmatic use. */
  verbose?: boolean;
  /**
   * How to authorize against the user's MCP server (HTTP/SSE only).
   * Inferred when omitted: 'bearer' if `bearer` is set, 'oauth' if neither set,
   * 'none' if explicitly set to 'none'. Stdio servers always use 'none'.
   */
  auth?: AuthMode;
  /** A pre-acquired OAuth 2.1 access token. Equivalent to `auth: 'bearer'`. */
  bearer?: string;
  /** OAuth scopes to request when auth='oauth'. */
  scopes?: string[];
  /**
   * Extra HTTP headers to send on every request to the user's MCP server (HTTP/SSE only).
   * Appended to bearer/oauth — `Authorization` set by auth modes is NOT overwritten by this field.
   * Common uses: tenant routing (`X-Tenant-Id`), version pinning, custom auth schemes.
   */
  headers?: Record<string, string>;
  /**
   * Disable interactive auto-OAuth. Per MCP spec, the SDK auto-initiates the OAuth 2.1
   * + PKCE flow when an HTTP server returns 401 with valid RFC 8414 metadata. Set this
   * to true in CI / non-TTY contexts where opening a browser would block the run.
   * The SDK also auto-detects non-TTY environments and disables auto-OAuth there;
   * this flag is for explicit override (e.g., a TTY-attached CI shell).
   */
  noInteractive?: boolean;
}

export interface RunResult {
  /** UUID assigned by the cloud API. */
  runId: string;
  /** Public-ish report URL — auth-gated for now, but stable. */
  reportUrl: string;
  /** Summary tally returned at end-of-run. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    warned: number;
    skipped: number;
  };
  /** True if the run completed without spawn/network errors. Independent of assertion failures. */
  ok: boolean;
}

/** Wire format for protocol messages relayed to the API. Kept minimal — no scoring metadata. */
export interface ProtocolMessage {
  /** Direction relative to the SDK: "in" = received from the user's server, "out" = SDK sent to the server. */
  direction: 'in' | 'out';
  /** Wall-clock timestamp at the SDK. */
  timestampMs: number;
  /** Latency vs the prior outbound message with the same id (in only). */
  latencyMs?: number;
  /** Raw JSON-RPC payload as a parsed object. */
  payload: Record<string, unknown>;
}

/** Auth surface probe — populated for HTTP/SSE transports only. */
export interface TraceAuthData {
  unauthenticated?: { status: number; wwwAuthenticate: string | null };
  metadataEndpoint?: {
    status: number;
    body: Record<string, unknown> | null;
    contentType?: string;
  };
  defaultEndpoints?: {
    authorizeStatus?: number;
    tokenStatus?: number;
    registerStatus?: number;
  };
  /**
   * True when the SDK had a usable bearer/oauth credential AT THE TIME OF UPLOAD.
   * The cloud uses this together with `unauthenticated.status` to classify the
   * run's AuthState (open / authenticated / auth-required-no-credentials / auth-credentials-invalid).
   * Absent (or false) means: SDK ran with no Authorization header. Never sent over the wire as a credential.
   */
  authProvided?: boolean;
}

/**
 * HTTP-method conformance probes for Streamable HTTP. Captured by the SDK
 * with safeFetch before the JSON-RPC probe sequence starts. Populated only
 * for transport === 'http'; stdio/sse leave this undefined.
 */
export interface TraceTransportProbes {
  get?: {
    status: number;
    contentType?: string;
    /** Names of all response headers starting with "access-control-" (case-insensitive). */
    corsHeaders: string[];
  };
  options?: {
    status: number;
    corsHeaders: string[];
  };
  delete?: {
    status: number;
    /** Up to 256 bytes of response body, UTF-8-decoded. */
    bodyText?: string;
    /**
     * True iff the body parsed as JSON contained a top-level `error.code`
     * (numeric) — i.e. a valid JSON-RPC error envelope. Tells the
     * assertion whether a 4xx is structured or arbitrary HTML/text.
     */
    hasJsonRpcErrorEnvelope?: boolean;
  };
}

/**
 * Tasks-capability probes. Populated only when the server's initialize
 * response declared `capabilities.tasks`. Carries the lifecycle exchanges
 * the TASK-* assertions need to verify the taskId / status contract.
 */
export interface TraceTasksProbes {
  capabilityDeclared: boolean;
  taskCreated?: { taskId?: string; status?: string };
  taskFetched?: { taskId?: string; status?: string };
  taskRepolled?: { status?: string };
}

/** Trace bundle uploaded to /api/v1/runs/score. */
export interface TraceBundle {
  /** SDK version that produced this trace. */
  sdkVersion: string;
  /** The user-supplied server command (stdio) or endpoint URL (http/sse), recorded verbatim for the report. */
  serverCommand: string;
  /** Which transport produced the trace. */
  transport?: TransportKind;
  /** Trace mode requested. */
  mode: Mode;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** Total wall-clock duration of trace capture. */
  durationMs: number;
  /** All protocol messages exchanged during the probe sequence. */
  messages: ProtocolMessage[];
  /** Stderr fragments captured from the server (helps with PRO-006 stderr cleanliness). */
  stderr: string[];
  /** Whether the server exited cleanly when stdin closed (helps with PRO-007 shutdown). */
  shutdown?: { exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null };
  /** Auth surface probe (HTTP/SSE only). Drives AUTH-* assertions. */
  auth?: TraceAuthData;
  /** HTTP-method probes (Streamable HTTP only). Drives TRANS-* assertions. */
  transportProbes?: TraceTransportProbes;
  /** Tasks-capability probes (when server advertised capabilities.tasks). Drives TASK-* assertions. */
  tasksProbes?: TraceTasksProbes;
}
