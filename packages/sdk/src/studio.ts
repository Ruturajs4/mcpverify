// Assert Studio CLI — runs a JSON-defined suite of test cases against the
// mcpverify cloud and returns aggregated pass/fail results.
//
// Designed for CI: read a checked-in suite file, upsert it server-side, post
// every case, fire the new `/run-all` endpoint, and pretty-print results.
//
// Zero new runtime dependencies — native fetch + node:fs/promises only.
//
// Wire format consumed by this module (the JSON file at `opts.suitePath`):
//
//   {
//     "name": "My MCP suite",
//     "description": "optional",
//     "cases": [
//       {
//         "name": "echo passes",
//         "description": "optional",
//         "kind": "scripted",
//         "yaml": "kind: scripted\nname: echo passes\n..."
//       },
//       ...
//     ]
//   }
//
// Each case's `yaml` field is sent verbatim to the API; the server re-parses
// and validates it against the studio-runner schema. That keeps THIS package
// dependency-free.

import { readFile } from 'node:fs/promises';
import { resolveApiKey } from './client.js';

// PE-sanity fix (2026-05-28): see client.ts for the rationale — api.mcpverify
// .dev has no DNS; everything lives behind https://mcpverify.dev today.
const DEFAULT_API_URL = 'https://mcpverify.dev';

// ---------- Public types ----------

export interface StudioSuiteCaseInput {
  name: string;
  description?: string;
  kind: 'scripted' | 'agentic';
  /** Pre-formatted test-case YAML. See `studio-suite-example.json` and docs. */
  yaml: string;
}

export interface StudioSuiteFile {
  name: string;
  description?: string;
  cases: StudioSuiteCaseInput[];
}

export interface StudioRunOptions {
  /** Absolute or relative path to the suite JSON file. */
  suitePath: string;
  /** MCPVerify API key. Defaults to MCPVERIFY_API_KEY. */
  apiKey?: string;
  /** Override API base URL. Defaults to MCPVERIFY_API_URL or production. */
  apiUrl?: string;
  /**
   * When true (default), reuse an existing suite with the same name instead of
   * creating a duplicate. Cases are still POSTed each run — duplicate cases
   * inside a reused suite are acceptable in v1 (the runner walks all cases).
   */
  upsertSuite?: boolean;
  /** Suppress informational stderr output. */
  quiet?: boolean;
}

export interface StudioCaseReport {
  caseId: string;
  caseName: string;
  kind: 'scripted' | 'agentic';
  runId: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'errored';
  verdict: 'pass' | 'fail' | 'warn' | null;
  latencyMs: number;
  error: string | null;
  reasoning: string | null;
}

export interface StudioRunResult {
  suiteId: string;
  /** Path-only URL returned by the API (e.g. `/studio/<id>`). */
  reportPath: string;
  /** Absolute report URL (apiUrl + reportPath). */
  reportUrl: string;
  cases: StudioCaseReport[];
  summary: { total: number; passed: number; failed: number; errored: number };
}

// ---------- Errors ----------

export class StudioApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'StudioApiError';
  }
}

export class StudioSuiteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioSuiteFileError';
  }
}

// ---------- Fetch timeout (Red Flags Bundle Phase E — RF-3 follow-up) ----------
//
// Mirror the timeouts wired into `CloudClient` so the legacy studio module's
// bare fetch() calls don't hang the CLI on a slow / unroutable host. We use
// the `status === 0` convention (same as ApiError + suite-runner) so the CLI
// handler in cli-handlers/studio.ts can branch on it uniformly.
const STUDIO_DEFAULT_TIMEOUT_MS = 30_000;

function studioTimeoutMs(): number {
  const raw = process.env['MCPVERIFY_API_TIMEOUT_MS'];
  if (!raw) return STUDIO_DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : STUDIO_DEFAULT_TIMEOUT_MS;
}

/**
 * Wrap a bare `fetch()` so an AbortSignal.timeout abort surfaces as
 * `StudioApiError(status=0, ...)`. All other errors re-throw unchanged so
 * existing network-error paths keep their semantics.
 */
async function studioFetch(endpoint: string, init: RequestInit): Promise<Response> {
  const ms = studioTimeoutMs();
  try {
    return await fetch(endpoint, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new StudioApiError(
        0,
        endpoint,
        `Request timed out after ${Math.round(ms / 1000)}s. Check MCPVERIFY_API_URL or your network.`,
      );
    }
    throw err;
  }
}

// ---------- Public entry point ----------

export async function runStudioSuite(opts: StudioRunOptions): Promise<StudioRunResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const apiUrl = (opts.apiUrl ?? process.env['MCPVERIFY_API_URL'] ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const upsert = opts.upsertSuite !== false;
  const quiet = opts.quiet === true;

  const log = (msg: string): void => { if (!quiet) process.stderr.write(`${msg}\n`); };

  // 1. Read + validate the suite JSON.
  const suite = await readSuiteFile(opts.suitePath);
  log(`[studio] loaded suite "${suite.name}" with ${suite.cases.length} case(s) from ${opts.suitePath}`);

  // 2. Upsert the suite.
  const suiteId = await upsertSuiteId(apiUrl, apiKey, suite, upsert, log);
  log(`[studio] using suite id ${suiteId}`);

  // 3. POST every case. Dupes in v1 are OK — the server runs them all.
  for (const c of suite.cases) {
    await postCase(apiUrl, apiKey, suiteId, c);
    log(`[studio]   + case "${c.name}" (${c.kind})`);
  }

  // 4. Fire run-all and read the aggregated response.
  log(`[studio] running all cases (server-side, sequential per-tier-concurrency)...`);
  const runAll = await runAllCases(apiUrl, apiKey, suiteId);

  // 5. Pretty-print to stderr (so stdout stays clean for piping JSON).
  printReport(runAll, quiet);

  return {
    suiteId,
    reportPath: runAll.reportUrl,
    reportUrl: `${apiUrl}${runAll.reportUrl}`,
    cases: runAll.cases,
    summary: runAll.summary,
  };
}

// ---------- Suite file loading ----------

async function readSuiteFile(path: string): Promise<StudioSuiteFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new StudioSuiteFileError(
      `Could not read suite file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StudioSuiteFileError(
      `Suite file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  return validateSuiteShape(parsed, path);
}

function validateSuiteShape(value: unknown, path: string): StudioSuiteFile {
  if (!isObject(value)) {
    throw new StudioSuiteFileError(`Suite file at ${path} must be a JSON object.`);
  }
  const name = value['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new StudioSuiteFileError(`Suite file at ${path} is missing required string field "name".`);
  }
  if (name.length > 120) {
    throw new StudioSuiteFileError(`Suite "name" must be <= 120 chars (got ${name.length}).`);
  }

  const description = value['description'];
  if (description !== undefined && typeof description !== 'string') {
    throw new StudioSuiteFileError(`Suite "description" must be a string when present.`);
  }

  const casesRaw = value['cases'];
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new StudioSuiteFileError(`Suite file at ${path} must have a non-empty "cases" array.`);
  }

  const cases: StudioSuiteCaseInput[] = casesRaw.map((c, i) => validateCaseShape(c, i, path));

  const out: StudioSuiteFile = { name: name.trim(), cases };
  if (typeof description === 'string') out.description = description.trim();
  return out;
}

function validateCaseShape(value: unknown, index: number, path: string): StudioSuiteCaseInput {
  const where = `cases[${index}] in ${path}`;
  if (!isObject(value)) {
    throw new StudioSuiteFileError(`${where} must be an object.`);
  }
  const name = value['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new StudioSuiteFileError(`${where}.name must be a non-empty string.`);
  }
  const kind = value['kind'];
  if (kind !== 'scripted' && kind !== 'agentic') {
    throw new StudioSuiteFileError(`${where}.kind must be "scripted" or "agentic" (got ${JSON.stringify(kind)}).`);
  }
  const yaml = value['yaml'];
  if (typeof yaml !== 'string' || yaml.trim().length === 0) {
    throw new StudioSuiteFileError(
      `${where}.yaml must be a non-empty string. Each case requires a pre-formatted YAML body — ` +
      `the studio-runner schema is the source of truth.`,
    );
  }
  const description = value['description'];
  if (description !== undefined && typeof description !== 'string') {
    throw new StudioSuiteFileError(`${where}.description must be a string when present.`);
  }

  const out: StudioSuiteCaseInput = { name: name.trim(), kind, yaml };
  if (typeof description === 'string') out.description = description.trim();
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- HTTP helpers ----------

async function upsertSuiteId(
  apiUrl: string,
  apiKey: string,
  suite: StudioSuiteFile,
  upsert: boolean,
  log: (m: string) => void,
): Promise<string> {
  if (upsert) {
    const existing = await listSuites(apiUrl, apiKey);
    const match = existing.find(s => s.name === suite.name);
    if (match) {
      log(`[studio] reusing existing suite "${suite.name}" (id=${match.id})`);
      return match.id;
    }
    log(`[studio] no existing suite named "${suite.name}" — creating a new one`);
  } else {
    log(`[studio] --no-upsert: creating a new suite even if a same-named one exists`);
  }

  const created = await createSuite(apiUrl, apiKey, suite.name, suite.description);
  log(`[studio] created suite id=${created.id}`);
  return created.id;
}

interface SuiteSummary { id: string; name: string }

async function listSuites(apiUrl: string, apiKey: string): Promise<SuiteSummary[]> {
  const endpoint = `${apiUrl}/api/v1/studio/suites`;
  const res = await studioFetch(endpoint, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  if (!res.ok) {
    throw new StudioApiError(res.status, endpoint, await readErrorBody(res, endpoint));
  }
  const body = await res.json() as { suites?: SuiteSummary[] };
  return Array.isArray(body.suites) ? body.suites : [];
}

async function createSuite(
  apiUrl: string,
  apiKey: string,
  name: string,
  description: string | undefined,
): Promise<SuiteSummary> {
  const endpoint = `${apiUrl}/api/v1/studio/suites`;
  const res = await studioFetch(endpoint, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
  });
  if (!res.ok) {
    throw new StudioApiError(res.status, endpoint, await readErrorBody(res, endpoint));
  }
  const body = await res.json() as { suite?: SuiteSummary };
  if (!body.suite?.id) {
    throw new StudioApiError(res.status, endpoint, 'Create-suite response missing suite.id');
  }
  return body.suite;
}

async function postCase(
  apiUrl: string,
  apiKey: string,
  suiteId: string,
  c: StudioSuiteCaseInput,
): Promise<void> {
  const endpoint = `${apiUrl}/api/v1/studio/suites/${suiteId}/cases`;
  const payload: Record<string, unknown> = { name: c.name, kind: c.kind, yaml: c.yaml };
  if (c.description) payload['description'] = c.description;
  const res = await studioFetch(endpoint, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new StudioApiError(
      res.status,
      endpoint,
      `Failed to create case "${c.name}": ${await readErrorBody(res, endpoint)}`,
    );
  }
}

interface RunAllResponse {
  suiteId: string;
  reportUrl: string;
  cases: StudioCaseReport[];
  summary: { total: number; passed: number; failed: number; errored: number };
}

async function runAllCases(
  apiUrl: string,
  apiKey: string,
  suiteId: string,
): Promise<RunAllResponse> {
  const endpoint = `${apiUrl}/api/v1/studio/suites/${suiteId}/run-all`;
  const res = await studioFetch(endpoint, {
    method: 'POST',
    headers: authHeaders(apiKey),
  });
  if (!res.ok) {
    throw new StudioApiError(res.status, endpoint, await readErrorBody(res, endpoint));
  }
  return await res.json() as RunAllResponse;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': 'mcpverify-sdk/studio',
  };
}

async function readErrorBody(res: Response, endpoint: string): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${endpoint} returned HTTP ${res.status}`;
  // Surface JSON `error` fields when present, otherwise raw text.
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (typeof json.error === 'string') return `HTTP ${res.status}: ${json.error}`;
  } catch { /* fall through */ }
  return `HTTP ${res.status}: ${text.slice(0, 400)}`;
}

// ---------- Pretty-print ----------

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  green: '[32m',
  red: '[31m',
  yellow: '[33m',
  cyan: '[36m',
  gray: '[90m',
};

function colorEnabled(): boolean {
  if (process.env['NO_COLOR']) return false;
  // process.stderr.isTTY is undefined on some pipe targets — treat that as no color.
  return process.stderr.isTTY === true;
}

function paint(text: string, color: keyof typeof ANSI): string {
  if (!colorEnabled()) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function statusLabel(s: StudioCaseReport['status'], verdict: StudioCaseReport['verdict']): string {
  if (s === 'passed') return paint('PASS', 'green');
  if (s === 'failed' || verdict === 'fail') return paint('FAIL', 'red');
  if (s === 'errored') return paint('ERROR', 'red');
  if (verdict === 'warn') return paint('WARN', 'yellow');
  return paint(String(s).toUpperCase(), 'gray');
}

function printReport(r: RunAllResponse, quiet: boolean): void {
  if (quiet) return;
  const out = process.stderr;
  out.write('\n');
  out.write(paint('Assert Studio — run-all results', 'bold') + '\n');
  out.write(paint(`suite=${r.suiteId}`, 'dim') + '\n');
  out.write('\n');

  const namePad = Math.min(60, Math.max(20, ...r.cases.map(c => c.caseName.length)));

  for (const c of r.cases) {
    const label = statusLabel(c.status, c.verdict);
    const name = c.caseName.length > namePad
      ? c.caseName.slice(0, namePad - 1) + '…'
      : c.caseName.padEnd(namePad);
    const latency = paint(`${c.latencyMs}ms`.padStart(8), 'dim');
    const kind = paint(c.kind.padEnd(8), 'cyan');
    out.write(`  ${label.padEnd(20)} ${name}  ${kind}  ${latency}\n`);
    if (c.error) {
      out.write(`    ${paint('error: ', 'red')}${c.error}\n`);
    } else if (c.verdict === 'fail' && c.reasoning) {
      // First line only, the rest is in the report URL.
      const firstLine = c.reasoning.split('\n')[0]!.trim();
      out.write(`    ${paint('why:   ', 'yellow')}${firstLine}\n`);
    }
  }

  const { total, passed, failed, errored } = r.summary;
  out.write('\n');
  const summaryLine =
    `${paint(`${passed} passed`, 'green')}, ` +
    `${paint(`${failed} failed`, failed > 0 ? 'red' : 'dim')}, ` +
    `${paint(`${errored} errored`, errored > 0 ? 'red' : 'dim')}  ` +
    paint(`(${total} total)`, 'dim');
  out.write(`  ${summaryLine}\n`);
  out.write(paint(`  report: ${r.reportUrl}`, 'dim') + '\n');
  out.write('\n');
}
