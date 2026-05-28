// @mcp-verify/redaction — pure-ESM trace + per-step result redactor.
//
// Lifted verbatim from apps/web/src/lib/redact-trace.ts. Verified pure ESM —
// no Buffer, no node:crypto, no node: imports. Safe in Edge runtime.
//
// Shared between:
//   - apps/web (renders /reports/[runId] + /demos/[suiteId] surfaces)
//   - packages/sdk (the local-MCP CLI redacts per_step_results before
//     uploading them to /api/v1/automation/suite-runs)
//
// LEAF PACKAGE: no dependencies on @mcp-verify/sdk or any other workspace
// package. The TraceBundle type lives in the SDK; here we use structural
// typing (RedactableTrace) so SDK's TraceBundle is assignable in without
// creating a redaction → SDK dependency cycle.
//
// Five passes:
//   1. JSON-RPC message headers     — Authorization, Cookie, X-API-Key, etc.
//   2. JSON-RPC message params      — keys matching /secret|password|token|.../i
//   3. serverCommand path stripping — strip /Users/<name>/ / /home/<name>/
//   4. stderr entries               — truncate + path-strip
//   5. auth.unauthenticated.headers — header redaction (keep WWW-Authenticate).
//      transportProbes/tasksProbes body fields — truncate + path-strip.
//
// Returns the redacted bundle PLUS a redactionCount.

// ---------------------------------------------------------------------------
// Public types — structural; consumers can pass their own typed objects
// (TraceBundle from @mcp-verify/sdk, per_step_results JSONB from web) as
// long as the shape matches.
// ---------------------------------------------------------------------------

// Structural shape the redactor walks. The SDK's TraceBundle (and any
// caller-defined trace type) is assignable to this so long as the listed
// fields are present in some form. No index signature — we don't want to
// over-constrain callers' concrete trace types.
export interface RedactableTrace {
  sdkVersion?: string;
  serverCommand?: unknown;
  transport?: string;
  mode?: string;
  startedAt?: string;
  durationMs?: number;
  messages?: unknown[];
  stderr?: unknown[];
  shutdown?: unknown;
  auth?: unknown;
  transportProbes?: unknown;
  tasksProbes?: unknown;
}

export interface RedactResult<T = RedactableTrace> {
  trace: T;
  /** Total number of fields the redactor touched. */
  redactionCount: number;
}

// ---------------------------------------------------------------------------
// Regex catalog
// ---------------------------------------------------------------------------

/** Header NAMES that always carry a secret value. Matched case-insensitively. */
const SECRET_HEADER_NAMES =
  /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|x-amz-security-token|bearer|proxy-authorization)$/i;

/** JSON-RPC param KEYS that look secret-shaped. Matched anywhere in the key. */
const SECRET_PARAM_KEY = /secret|password|token|api[_-]?key|bearer|credential/i;

/**
 * Local-machine PATH prefixes. Strips the username segment + everything before
 * it so a leaked `node /Users/ada/src/my-mcp/server.js` becomes `node ~`.
 * Skipped for HTTP/SSE transports — there the serverCommand IS the URL and is
 * intentional showcase data.
 */
const LOCAL_PATH_REGEX = /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s/\\]+(?:[/\\][^\s]*)?/g;

const STDERR_TRUNCATE_AT = 200;
const PROBE_BODY_TRUNCATE_AT = 500;

const REDACTED = '<redacted>';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact a trace bundle for anonymous-visitor consumption. Pure — no side
 * effects, never throws. Returns a structurally-identical bundle with secret
 * values replaced by `"<redacted>"` and stderr/probe-body text truncated.
 *
 * Generic over T so callers can preserve their concrete type (e.g.
 * TraceBundle from @mcp-verify/sdk) on the return.
 */
export function redactTrace<T extends RedactableTrace>(input: T): RedactResult<T> {
  const counter = { n: 0 };

  let cloned: T;
  try {
    cloned = JSON.parse(JSON.stringify(input)) as T;
  } catch {
    // Malformed input — return a safe stub rather than crashing the page.
    return {
      trace: {
        sdkVersion: 'unknown',
        serverCommand: '<unredactable>',
        mode: 'quick',
        startedAt: new Date(0).toISOString(),
        durationMs: 0,
        messages: [],
        stderr: [],
      } as unknown as T,
      redactionCount: 0,
    };
  }

  // Pass 3 — serverCommand path strip (skipped for http/sse where the URL is
  // intentional showcase data).
  const transport = (cloned.transport as string | undefined) ?? 'stdio';
  if (
    transport !== 'http' &&
    transport !== 'sse' &&
    typeof cloned.serverCommand === 'string'
  ) {
    const before = cloned.serverCommand;
    cloned.serverCommand = before.replace(LOCAL_PATH_REGEX, '~');
    if (cloned.serverCommand !== before) counter.n += 1;
  }

  // Pass 1 + 2 — walk JSON-RPC messages, redacting headers + secret params.
  if (Array.isArray(cloned.messages)) {
    for (const message of cloned.messages) {
      if (message && typeof message === 'object' && 'payload' in message) {
        redactJsonRpcPayload((message as { payload: unknown }).payload, counter);
      }
    }
  }

  // Pass 4 — stderr truncation + path strip.
  if (Array.isArray(cloned.stderr)) {
    cloned.stderr = cloned.stderr.map((entry) => {
      if (typeof entry !== 'string') return entry;
      const pathStripped = entry.replace(LOCAL_PATH_REGEX, '~');
      if (pathStripped !== entry) counter.n += 1;
      if (pathStripped.length > STDERR_TRUNCATE_AT) {
        counter.n += 1;
        return `${pathStripped.slice(0, STDERR_TRUNCATE_AT)}[...redacted ${
          pathStripped.length - STDERR_TRUNCATE_AT
        } more chars]`;
      }
      return pathStripped;
    });
  }

  // Pass 5 — auth.unauthenticated.headers.
  const auth = cloned.auth;
  if (auth && typeof auth === 'object' && 'unauthenticated' in auth) {
    const ua = (auth as { unauthenticated?: Record<string, unknown> }).unauthenticated;
    if (ua && ua['headers'] && typeof ua['headers'] === 'object') {
      const headers = ua['headers'] as Record<string, unknown>;
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'www-authenticate') continue; // keep verbatim
        if (
          SECRET_HEADER_NAMES.test(name) &&
          typeof value === 'string' &&
          value !== REDACTED
        ) {
          headers[name] = REDACTED;
          counter.n += 1;
        }
      }
    }
  }

  // Pass 5b — transportProbes + tasksProbes body fields.
  if (cloned.transportProbes && typeof cloned.transportProbes === 'object') {
    for (const probe of Object.values(
      cloned.transportProbes as Record<string, unknown>,
    ) as Array<Record<string, unknown> | undefined>) {
      if (!probe) continue;
      if (typeof probe['bodyText'] === 'string') {
        probe['bodyText'] = truncateAndStrip(
          probe['bodyText'] as string,
          PROBE_BODY_TRUNCATE_AT,
          counter,
        );
      }
    }
  }
  if (cloned.tasksProbes && typeof cloned.tasksProbes === 'object') {
    for (const probe of Object.values(
      cloned.tasksProbes as Record<string, unknown>,
    ) as Array<Record<string, unknown> | undefined>) {
      if (!probe) continue;
      if (typeof probe['body'] === 'string') {
        probe['body'] = truncateAndStrip(
          probe['body'] as string,
          PROBE_BODY_TRUNCATE_AT,
          counter,
        );
      }
    }
  }

  return { trace: cloned, redactionCount: counter.n };
}

/**
 * Redact a single string. Used for header values, observed/expected/
 * remediation copy on assertion_results, and any arbitrary text that may
 * contain a bearer token, api-key, or local-machine path.
 *
 * Patterns covered:
 *   - `Bearer <token>` / `bearer <token>` → `Bearer <redacted>`
 *   - `api_key=...`, `apiKey=...`, `?token=...` → `key=<redacted>`
 *   - Local-machine paths from LOCAL_PATH_REGEX → `~`
 */
export function redactString(input: string): { value: string; redacted: boolean } {
  if (typeof input !== 'string') return { value: input, redacted: false };
  let out = input;
  let touched = false;

  const bearerRe =
    /(bearer|token|api[_-]?key|secret|password|credential)\s*[:=]\s*['"]?([A-Za-z0-9._\-+/=]{8,})['"]?/gi;
  out = out.replace(bearerRe, (_m, key: string) => {
    touched = true;
    return `${key}=${REDACTED}`;
  });

  // Standalone `Bearer abc123def...` (whitespace separator, no `:` or `=`).
  out = out.replace(/\b(Bearer)\s+([A-Za-z0-9._\-+/=]{8,})\b/g, (_m, key: string) => {
    touched = true;
    return `${key} ${REDACTED}`;
  });

  const beforePath = out;
  out = out.replace(LOCAL_PATH_REGEX, '~');
  if (out !== beforePath) touched = true;

  return { value: out, redacted: touched };
}

/**
 * Redact per_step_results from a test_runs row before exposing it to
 * anonymous visitors OR uploading it to the cloud from the SDK's local-MCP
 * runner. Walks the JSONB shape captured by studio-runner:
 *
 *   [{ stepIndex, name, kind, latencyMs, resolvedArguments, response, assertions }, ...]
 *
 * Each step's `resolvedArguments` (post-fixture-interpolation values that may
 * embed local secrets) and `response` (raw RPC response that may echo a
 * bearer back) get walked through the same JSON-RPC redactor used for trace
 * messages. Returns a deep-cloned, redacted array.
 *
 * Defensive: malformed input (non-array, missing fields) returns the input
 * verbatim — the redactor is best-effort, not a validator. Use a separate
 * schema check upstream if you need to reject bad shapes.
 */
export function redactPerStepResults<T>(input: T): { value: T; redactionCount: number } {
  if (!Array.isArray(input)) return { value: input, redactionCount: 0 };
  const counter = { n: 0 };
  let cloned: unknown[];
  try {
    cloned = JSON.parse(JSON.stringify(input)) as unknown[];
  } catch {
    return { value: input, redactionCount: 0 };
  }
  for (const step of cloned) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    if (s['resolvedArguments'] && typeof s['resolvedArguments'] === 'object') {
      redactJsonRpcPayload(s['resolvedArguments'], counter);
    }
    if (s['response'] !== undefined) {
      redactJsonRpcPayload(s['response'], counter);
    }
  }
  return { value: cloned as unknown as T, redactionCount: counter.n };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function redactJsonRpcPayload(node: unknown, counter: { n: number }): void {
  if (Array.isArray(node)) {
    for (const item of node) redactJsonRpcPayload(item, counter);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    // Pass 1 — header NAMES that always carry secrets.
    if (
      SECRET_HEADER_NAMES.test(key) &&
      typeof value === 'string' &&
      value !== REDACTED
    ) {
      obj[key] = REDACTED;
      counter.n += 1;
      continue;
    }
    // Pass 2 — secret-shaped param KEYS regardless of context.
    if (
      SECRET_PARAM_KEY.test(key) &&
      typeof value === 'string' &&
      value !== REDACTED
    ) {
      obj[key] = REDACTED;
      counter.n += 1;
      continue;
    }
    // For string values that aren't matched by key — scan for bearer-shaped
    // tokens embedded in arbitrary copy.
    if (typeof value === 'string') {
      const stripped = redactString(value);
      if (stripped.redacted) {
        obj[key] = stripped.value;
        counter.n += 1;
      }
      continue;
    }
    if (value && typeof value === 'object') {
      redactJsonRpcPayload(value, counter);
    }
  }
}

function truncateAndStrip(input: string, limit: number, counter: { n: number }): string {
  const pathStripped = input.replace(LOCAL_PATH_REGEX, '~');
  if (pathStripped !== input) counter.n += 1;
  if (pathStripped.length <= limit) return pathStripped;
  counter.n += 1;
  return `${pathStripped.slice(0, limit)}[...redacted ${pathStripped.length - limit} more chars]`;
}
