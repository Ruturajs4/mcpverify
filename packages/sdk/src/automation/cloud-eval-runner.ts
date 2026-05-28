// Cloud-eval suite runner — T-184 replacement for the in-process scoring path.
//
// Architecture (the founder's "lightweight CLI" goal):
//   1. Fetch /api/v1/automation/suites/<id>/runnable (auth'd, no secrets on wire).
//   2. Start a client-driven suite_run via /api/v1/studio/suites/<id>/run-all.
//   3. For each scripted case:
//        a. Parse YAML via @mcp-verify/studio-runner schema (OSS-safe).
//        b. Open transport via @mcp-verify/sdk (stdio or HTTP).
//        c. For each step:
//             - Resolve fixture refs from --local-config (stdio path only).
//             - Call the JSON-RPC method (tools/call, prompts/get, resources/read).
//             - Capture the response + timing.
//             - POST to /api/v1/automation/suites/<id>/runs/<rid>/steps/<cid>/evaluate.
//             - Receive per-step verdict.
//        d. POST aggregated case result to /case-result for finalization.
//   4. Aggregate + return summary.
//
// What's NOT here (intentional limitations of the v0.7.0 cut):
//   - Agentic cases: still cloud-only path (cloud has the LLM key); CLI skips them
//     with a clear message and a `status: 'skipped'` case-result POST.
//   - HTTP/SSE transports: scaffold returns "not yet supported in v0.7"; the
//     follow-up patch adds proper fixture resolution for these.
//   - Multi-step bindings ({{step1.$.foo}}): basic interpolation supported below.
//
// All of these can be added in follow-ups without changing the wire shape or the
// closed studio-runtime — they're purely SDK-side enhancements.

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  parseTestCase,
  type ScriptedTestCase,
  type Target,
  type ScriptedStep,
} from '@mcp-verify/studio-runner';
import {
  openTransport,
  type FixtureResolver,
} from '@mcp-verify/studio-runner/transport-factory';
import { redactPerStepResults } from '@mcp-verify/redaction';

const DEFAULT_API_URL = 'https://mcpverify.dev';

// ---------- Public API ----------

export interface CloudEvalRunOptions {
  /** Cloud suite id (UUID). */
  suiteId: string;
  /** MCPVerify API key. Defaults to MCPVERIFY_API_KEY env var. */
  apiKey?: string;
  /** Override API base URL. Defaults to MCPVERIFY_API_URL or production. */
  apiUrl?: string;
  /** Path to the --local-config JSON file (stdio servers + local fixtures). */
  localConfigPath?: string;
  /** Suppress informational stderr messages. */
  quiet?: boolean;
  /** Extra debug logging on stderr. */
  verbose?: boolean;
  /** Optional per-case progress callback. */
  onCase?: (event: CloudEvalCaseEvent) => void;
}

export interface CloudEvalCaseEvent {
  caseId: string;
  caseName: string;
  kind: 'scripted' | 'agentic';
  phase: 'start' | 'done' | 'skipped';
  status?: 'passed' | 'failed' | 'errored' | 'skipped';
  verdict?: 'pass' | 'fail' | 'warn' | null;
  latencyMs?: number;
  error?: string | null;
}

export interface CloudEvalCaseReport {
  caseId: string;
  caseName: string;
  kind: 'scripted' | 'agentic';
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  verdict: 'pass' | 'fail' | 'warn' | null;
  latencyMs: number;
  error: string | null;
}

export interface CloudEvalRunResult {
  suiteId: string;
  suiteRunId: string;
  caseCount: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  cases: CloudEvalCaseReport[];
  /** mcpverify.dev URL to view this suite_run in the UI. */
  reportUrl: string;
}

export class CloudEvalApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'CloudEvalApiError';
  }
}

// ---------- Internal types matching the runnable wire shape ----------

interface RunnableCase {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  agent_id: string | null;
  yaml: string;
}

interface RunnableServer {
  id: string;
  transport: string;
  url: string | null;
}

interface RunnableResponse {
  suite: { id: string; name: string };
  server: RunnableServer;
  cases: RunnableCase[];
}

interface LocalConfig {
  server?: { command: string; args?: string[]; env?: Record<string, string> };
  fixtures?: Record<string, string>;
}

// ---------- Public entry ----------

export async function runSuiteViaCloudEval(
  opts: CloudEvalRunOptions,
): Promise<CloudEvalRunResult> {
  const apiKey = opts.apiKey ?? process.env['MCPVERIFY_API_KEY'];
  if (!apiKey) {
    throw new CloudEvalApiError(
      0,
      'Missing API key. Set MCPVERIFY_API_KEY or pass --api-key. ' +
        'Grab an invite at https://mcpverify.dev/invite.',
    );
  }
  const apiUrl = (opts.apiUrl ?? process.env['MCPVERIFY_API_URL'] ?? DEFAULT_API_URL).replace(/\/+$/, '');

  const log = (m: string): void => {
    if (!opts.quiet) process.stderr.write(`${m}\n`);
  };
  const debug = (m: string): void => {
    if (opts.verbose && !opts.quiet) process.stderr.write(`${m}\n`);
  };

  // 1. Load --local-config (optional unless server is stdio).
  let localConfig: LocalConfig = {};
  if (opts.localConfigPath) {
    try {
      localConfig = JSON.parse(readFileSync(opts.localConfigPath, 'utf8')) as LocalConfig;
    } catch (err) {
      throw new Error(
        `local-config read/parse failed at ${opts.localConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Fetch the runnable payload.
  debug(`[cloud-eval] fetching runnable suite ${opts.suiteId}`);
  const runnable = await fetchRunnable(apiUrl, apiKey, opts.suiteId);
  log(
    `[cloud-eval] loaded "${runnable.suite.name}" (${runnable.cases.length} case${runnable.cases.length === 1 ? '' : 's'})`,
  );

  // 3. Resolve transport target.
  let target: Target;
  if (runnable.server.transport === 'stdio') {
    if (!localConfig.server) {
      throw new Error(
        'suite is bound to a stdio server but --local-config has no `server` block. ' +
          'Add { "server": { "command": "..." } } to your config file.',
      );
    }
    target = {
      transport: 'stdio',
      command: buildStdioCommand(localConfig.server),
    };
  } else if (runnable.server.transport === 'http' || runnable.server.transport === 'sse') {
    // HTTP/SSE scaffold — fixture resolution for these transports needs the
    // bearer to live cloud-side. For v0.7.0 we surface a clear error rather
    // than half-running. Follow-up patch wires this through /resolved or
    // a new HTTP-fixture-resolution flow.
    throw new Error(
      `cloud-eval runner v0.7.0 supports stdio servers only; this suite is bound to a ${runnable.server.transport} server. ` +
        'Use the dashboard at ' + apiUrl + '/suites/' + opts.suiteId + ' to run it cloud-side until the next patch.',
    );
  } else {
    throw new Error(`unknown server.transport "${runnable.server.transport}"`);
  }

  // 4. Start a client-driven suite_run.
  const suiteRunId = await startSuiteRun(apiUrl, apiKey, opts.suiteId, runnable.cases.length);
  log(`[cloud-eval] suite_run_id=${suiteRunId}`);

  // 5. Local fixture resolver (--local-config.fixtures only).
  const localFixtures = localConfig.fixtures ?? {};
  const resolveFixture: FixtureResolver = (name: string): string => {
    if (Object.prototype.hasOwnProperty.call(localFixtures, name)) {
      return localFixtures[name]!;
    }
    throw new Error(
      `local-mode fixture "${name}" not found in --local-config.fixtures. ` +
        `Add it to the config file or remove the reference from the case YAML.`,
    );
  };

  // 6. Run each case.
  const reports: CloudEvalCaseReport[] = [];

  for (const caseDef of runnable.cases) {
    opts.onCase?.({
      caseId: caseDef.id,
      caseName: caseDef.name,
      kind: caseDef.kind as 'scripted' | 'agentic',
      phase: 'start',
    });

    if (caseDef.kind === 'agentic') {
      // Agentic cases need the LLM judge cloud-side. Skip with a clear message.
      const skipReport: CloudEvalCaseReport = {
        caseId: caseDef.id,
        caseName: caseDef.name,
        kind: 'agentic',
        status: 'skipped',
        verdict: null,
        latencyMs: 0,
        error: 'agentic cases run cloud-side only; use the dashboard for this case.',
      };
      reports.push(skipReport);
      opts.onCase?.({
        caseId: caseDef.id,
        caseName: caseDef.name,
        kind: 'agentic',
        phase: 'skipped',
        error: skipReport.error,
      });
      await postCaseResult(apiUrl, apiKey, opts.suiteId, suiteRunId, {
        case_id: caseDef.id,
        status: 'skipped',
        latency_ms: 0,
        ...(skipReport.error ? { error: skipReport.error } : {}),
      }).catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[cloud-eval] warning: case-result POST failed for "${caseDef.name}": ${m}\n`);
      });
      continue;
    }

    // Scripted path.
    const result = await runOneScriptedCase({
      caseDef,
      target,
      apiUrl,
      apiKey,
      suiteId: opts.suiteId,
      suiteRunId,
      resolveFixture,
      log,
      debug,
    });

    const report: CloudEvalCaseReport = {
      caseId: caseDef.id,
      caseName: caseDef.name,
      kind: 'scripted',
      status: result.status,
      verdict: result.verdict,
      latencyMs: result.latencyMs,
      error: result.error,
    };
    reports.push(report);

    opts.onCase?.({
      caseId: caseDef.id,
      caseName: caseDef.name,
      kind: 'scripted',
      phase: 'done',
      status: result.status,
      verdict: result.verdict,
      latencyMs: result.latencyMs,
      error: result.error,
    });

    const { value: redactedSteps } = redactPerStepResults(result.perStepResults);
    await postCaseResult(apiUrl, apiKey, opts.suiteId, suiteRunId, {
      case_id: caseDef.id,
      status: result.status,
      latency_ms: result.latencyMs,
      ...(result.verdict !== null ? { verdict: result.verdict } : {}),
      ...(redactedSteps !== undefined ? { per_step_results: redactedSteps } : {}),
      ...(result.error ? { error: result.error } : {}),
    }).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[cloud-eval] warning: case-result POST failed for "${caseDef.name}": ${m}\n`);
    });
  }

  // 7. Aggregate.
  const passed = reports.filter((r) => r.status === 'passed').length;
  const failed = reports.filter((r) => r.status === 'failed').length;
  const errored = reports.filter((r) => r.status === 'errored').length;
  const skipped = reports.filter((r) => r.status === 'skipped').length;

  return {
    suiteId: opts.suiteId,
    suiteRunId,
    caseCount: reports.length,
    passed,
    failed,
    errored,
    skipped,
    cases: reports,
    reportUrl: `${apiUrl}/suites/${opts.suiteId}/runs/${suiteRunId}`,
  };
}

// ---------- Per-case scripted runner ----------

interface ScriptedCaseResult {
  status: 'passed' | 'failed' | 'errored';
  verdict: 'pass' | 'fail' | 'warn' | null;
  latencyMs: number;
  error: string | null;
  perStepResults: unknown[];
}

interface RunOneArgs {
  caseDef: RunnableCase;
  target: Target;
  apiUrl: string;
  apiKey: string;
  suiteId: string;
  suiteRunId: string;
  resolveFixture: FixtureResolver;
  log: (m: string) => void;
  debug: (m: string) => void;
}

async function runOneScriptedCase(args: RunOneArgs): Promise<ScriptedCaseResult> {
  const { caseDef, target, apiUrl, apiKey, suiteId, suiteRunId, resolveFixture, log, debug } = args;
  const caseStart = Date.now();

  let parsed: ScriptedTestCase;
  try {
    const doc = YAML.parse(caseDef.yaml) as unknown;
    const result = parseTestCase(doc);
    if (result.kind !== 'scripted') {
      return errored(`expected scripted case, got kind="${result.kind}"`);
    }
    parsed = result;
  } catch (err) {
    return errored(`YAML/schema error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The schema's `target` is optional post-Decision F (it lives on the suite,
  // not the case YAML), so we pass the resolved `target` directly rather than
  // mutating the parsed case.

  // Open transport.
  let transport;
  try {
    transport = await openTransport(target, resolveFixture);
  } catch (err) {
    return errored(`transport open failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const perStepResults: unknown[] = [];
  const bindings: Record<string, unknown> = {};
  let stepIdx = 0;
  let caseVerdict: 'pass' | 'fail' | 'warn' = 'pass';
  let caseError: string | null = null;

  try {
    for (const step of parsed.steps) {
      const stepStart = Date.now();
      let response: unknown = null;
      let transportError: string | null = null;
      let stepArgs: Record<string, unknown> | undefined;

      try {
        stepArgs = await resolveStepArguments(step, bindings, resolveFixture);
        response = await invokeStep(transport, step, stepArgs);
      } catch (err) {
        transportError = err instanceof Error ? err.message : String(err);
      }

      const stepEnd = Date.now();
      const latencyMs = stepEnd - stepStart;

      // Capture per-step record (matches PerStepResult shape).
      perStepResults.push({
        stepIndex: stepIdx,
        kind: step.kind,
        name: step.name,
        resolvedArguments: stepArgs ?? {},
        response,
        latencyMs,
        assertions: [],
      });

      // POST to cloud /evaluate for scoring.
      let stepVerdict: 'pass' | 'fail' | 'warn' = 'fail';
      try {
        const evalResponse = await postEvaluate(apiUrl, apiKey, suiteId, suiteRunId, caseDef.id, {
          schema_version: 'v1',
          case_id: caseDef.id,
          step_index: stepIdx,
          step: {
            kind: step.kind,
            name: step.name,
            method: methodForStepKind(step.kind),
            started_at_ms: stepStart,
            completed_at_ms: stepEnd,
            latency_ms: latencyMs,
          },
          response,
          transport_error: transportError,
        });
        stepVerdict = evalResponse.step_verdict;
        // Stitch the evaluator's assertion results back into the per-step record.
        const lastStep = perStepResults[perStepResults.length - 1] as { assertions: unknown[] };
        lastStep.assertions = evalResponse.assertions;
        log(`  [step ${stepIdx + 1}/${parsed.steps.length}] ${step.name} → ${stepVerdict}`);
      } catch (err) {
        stepVerdict = 'fail';
        caseError = `step ${stepIdx} /evaluate failed: ${err instanceof Error ? err.message : String(err)}`;
        debug(caseError);
      }

      // Promote step verdict to the case-level worst.
      if (stepVerdict === 'fail' || caseVerdict === 'fail') {
        caseVerdict = 'fail';
      } else if (stepVerdict === 'warn' && caseVerdict === 'pass') {
        caseVerdict = 'warn';
      }

      // Bind step result for subsequent steps' {{step<i>.$.foo}} interpolation.
      bindings[`step${stepIdx}`] = response;

      stepIdx++;
    }
  } finally {
    try {
      await transport.stop();
    } catch {
      // ignore — transport close errors don't fail the case
    }
  }

  const latencyMs = Date.now() - caseStart;
  const status: 'passed' | 'failed' | 'errored' = caseError
    ? 'errored'
    : caseVerdict === 'pass'
      ? 'passed'
      : 'failed';

  return {
    status,
    verdict: caseError ? null : caseVerdict,
    latencyMs,
    error: caseError,
    perStepResults,
  };
}

function errored(msg: string): ScriptedCaseResult {
  return {
    status: 'errored',
    verdict: null,
    latencyMs: 0,
    error: msg,
    perStepResults: [],
  };
}

// ---------- Step execution helpers ----------

function methodForStepKind(kind: string): string {
  // Maps the studio-runner schema's step kinds to the JSON-RPC method strings
  // we send to the MCP server. Keep in sync with the kinds the schema accepts.
  switch (kind) {
    case 'tools/call':
    case 'tool':
      return 'tools/call';
    case 'prompts/get':
    case 'prompt':
      return 'prompts/get';
    case 'resources/read':
    case 'resource':
      return 'resources/read';
    default:
      return kind;
  }
}

async function resolveStepArguments(
  step: ScriptedStep,
  bindings: Record<string, unknown>,
  resolveFixture: FixtureResolver,
): Promise<Record<string, unknown>> {
  const raw = (step as { arguments?: Record<string, unknown> }).arguments ?? {};
  return interpolate(raw, bindings, resolveFixture) as Record<string, unknown>;
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function interpolate(
  value: unknown,
  bindings: Record<string, unknown>,
  resolveFixture: FixtureResolver,
): unknown {
  if (typeof value === 'string') {
    return value.replace(TEMPLATE_RE, (_m, raw: string) => {
      const token = String(raw).trim();
      if (token.startsWith('fixture.')) {
        const name = token.slice('fixture.'.length);
        const v = resolveFixture(name);
        return typeof v === 'string' ? v : String(v);
      }
      if (token.startsWith('step')) {
        // Very basic step.N or stepN.$.foo lookup. Full JSONPath in interpolation
        // is a future enhancement; for v0.7.0 we support the literal token.
        const direct = bindings[token];
        if (direct !== undefined) return String(direct);
      }
      return `{{${raw}}}`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, bindings, resolveFixture));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, bindings, resolveFixture);
    return out;
  }
  return value;
}

async function invokeStep(
  transport: { request: (m: string, p?: unknown) => Promise<unknown> },
  step: ScriptedStep,
  args: Record<string, unknown>,
): Promise<unknown> {
  const method = methodForStepKind(step.kind);
  if (method === 'tools/call') {
    return transport.request('tools/call', { name: step.name, arguments: args });
  }
  if (method === 'prompts/get') {
    return transport.request('prompts/get', { name: step.name, arguments: args });
  }
  if (method === 'resources/read') {
    return transport.request('resources/read', { uri: step.name });
  }
  // Fallback: pass-through. Unrecognized kinds reject server-side anyway.
  return transport.request(method, { name: step.name, arguments: args });
}

// ---------- HTTP plumbing ----------

async function fetchRunnable(apiUrl: string, apiKey: string, suiteId: string): Promise<RunnableResponse> {
  const res = await fetch(`${apiUrl}/api/v1/automation/suites/${encodeURIComponent(suiteId)}/runnable`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new CloudEvalApiError(res.status, `GET /runnable failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as RunnableResponse;
}

async function startSuiteRun(
  apiUrl: string,
  apiKey: string,
  suiteId: string,
  caseCount: number,
): Promise<string> {
  const res = await fetch(
    `${apiUrl}/api/v1/studio/suites/${encodeURIComponent(suiteId)}/run-all`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ mode: 'client-driven', case_count: caseCount }),
    },
  );
  if (res.status !== 202 && res.status !== 200) {
    const body = await res.text().catch(() => '');
    throw new CloudEvalApiError(res.status, `POST /run-all failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { suite_run_id?: string };
  if (!data.suite_run_id) {
    throw new CloudEvalApiError(res.status, 'POST /run-all did not return suite_run_id');
  }
  return data.suite_run_id;
}

interface EvaluateRequest {
  schema_version: 'v1';
  case_id: string;
  step_index: number;
  step: {
    kind: string;
    name: string;
    method: string;
    started_at_ms: number;
    completed_at_ms: number;
    latency_ms: number;
  };
  response: unknown;
  transport_error: string | null;
}

interface EvaluateResponse {
  schema_version: 'v1';
  step_index: number;
  assertions: Array<{ verdict: 'pass' | 'fail' | 'warn'; observed?: string; expected?: string; error?: string }>;
  step_verdict: 'pass' | 'fail' | 'warn';
}

// PE flag 2 — Retry-After backoff. A 60+-step suite from a fast CI runner
// can trip the per-IP limit (or per-key in pathological cases). Without
// backoff, the SDK throws immediately and the user sees a half-evaluated
// suite_run stuck in `running`. We honor Retry-After up to MAX_BACKOFF_RETRIES
// times per step before giving up.
const MAX_BACKOFF_RETRIES = 5;
const MAX_BACKOFF_SECONDS = 120; // safety ceiling — never sleep > 2 min

async function postEvaluate(
  apiUrl: string,
  apiKey: string,
  suiteId: string,
  runId: string,
  caseId: string,
  body: EvaluateRequest,
): Promise<EvaluateResponse> {
  const url =
    `${apiUrl}/api/v1/automation/suites/${encodeURIComponent(suiteId)}` +
    `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(caseId)}/evaluate`;

  for (let attempt = 0; attempt <= MAX_BACKOFF_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return (await res.json()) as EvaluateResponse;
    }
    if (res.status === 429 && attempt < MAX_BACKOFF_RETRIES) {
      const retryAfterRaw = res.headers.get('Retry-After');
      const retryAfter = clampRetryAfter(retryAfterRaw, attempt);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      await sleep(retryAfter * 1000);
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new CloudEvalApiError(
        429,
        `rate-limited (gave up after ${MAX_BACKOFF_RETRIES + 1} attempts)`,
      );
    }
    throw new CloudEvalApiError(res.status, `POST /evaluate failed (${res.status}): ${text.slice(0, 200)}`);
  }
  // Unreachable — the loop always returns or throws.
  throw new CloudEvalApiError(0, 'unreachable: retry loop exhausted without resolution');
}

/**
 * Parse the Retry-After header (RFC 7231 §7.1.3 — seconds or HTTP-date) and
 * clamp to a safety ceiling. Backs off exponentially when the server didn't
 * supply a value (or supplied a nonsense one).
 */
function clampRetryAfter(raw: string | null, attempt: number): number {
  const expBackoff = Math.min(MAX_BACKOFF_SECONDS, 2 ** attempt);
  if (!raw) return expBackoff;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.min(MAX_BACKOFF_SECONDS, asSeconds);
  }
  // HTTP-date form — best-effort parse, fall back to exponential.
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return Math.min(MAX_BACKOFF_SECONDS, seconds);
  }
  return expBackoff;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CaseResultPayload {
  case_id: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  latency_ms: number;
  verdict?: 'pass' | 'fail' | 'warn';
  per_step_results?: unknown;
  error?: string;
}

async function postCaseResult(
  apiUrl: string,
  apiKey: string,
  suiteId: string,
  runId: string,
  body: CaseResultPayload,
): Promise<void> {
  const url =
    `${apiUrl}/api/v1/studio/suites/${encodeURIComponent(suiteId)}` +
    `/run-all/${encodeURIComponent(runId)}/case-result`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CloudEvalApiError(res.status, `POST /case-result failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

function buildStdioCommand(server: { command: string; args?: string[]; env?: Record<string, string> }): string {
  // Re-stringify into the format StdioTransport expects (single shell-ish line).
  // Spawn shape: command + args. Env is set via process.env in the transport.
  const parts = [server.command, ...(server.args ?? [])];
  return parts.join(' ');
}
