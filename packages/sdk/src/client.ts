// API client for mcpverify.dev — uploads the trace and streams scoring results back.

import type { Mode, RunResult, TraceBundle } from './types.js';

const DEFAULT_API_URL = 'https://api.mcpverify.dev';

// Red Flags Bundle Phase E — fetch timeouts.
//
// Every CLI helper here now wraps fetch() in AbortSignal.timeout so a hung
// server / unroutable host doesn't hang the CLI indefinitely. Defaults are
// 30s for the small request/response endpoints (get/post/delete/patch) and
// 60s for submitTrace (uploads). Overridable per env var for CI / slow
// corporate networks. streamResults is excluded — it's supposed to be
// long-lived (SSE); a separate stall detector is a Phase 2.5 follow-up.
const DEFAULT_TIMEOUT_MS = 30_000;
const SUBMIT_TRACE_TIMEOUT_MS = 60_000;

function timeoutMs(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Wrap an AbortError thrown by AbortSignal.timeout(...) into the codebase's
 * typed ApiError with status=0 (the "did not reach the server" convention).
 * Re-throws everything else unchanged so existing error mapping stays intact.
 */
function rethrowTimeoutOrOriginal(err: unknown, ms: number, hint: string): never {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    throw new ApiError(
      0,
      `Request timed out after ${Math.round(ms / 1000)}s. ${hint}`,
    );
  }
  throw err;
}

export class CloudClient {
  constructor(
    public readonly apiKey: string,
    public readonly apiUrl: string = DEFAULT_API_URL,
  ) {}

  /**
   * Generic GET helper. Used by McpVerifyClient namespaced methods
   * (compliance.listRuns, automation.listSuites, servers.list, etc.) to
   * call list / view endpoints. Throws ApiError on non-2xx.
   */
  async get<T>(path: string): Promise<T> {
    const ms = timeoutMs('MCPVERIFY_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      rethrowTimeoutOrOriginal(err, ms, 'Check MCPVERIFY_API_URL or your network.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `GET ${path} returned ${res.status}`);
    }
    return await res.json() as T;
  }

  /**
   * Generic POST helper. Used by McpVerifyClient for dispatch endpoints
   * (automation.runCase, etc.). Mirrors `get` for symmetry.
   */
  async post<T>(path: string, body: unknown = {}): Promise<T> {
    const ms = timeoutMs('MCPVERIFY_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      rethrowTimeoutOrOriginal(err, ms, 'Check MCPVERIFY_API_URL or your network.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `POST ${path} returned ${res.status}`);
    }
    return await res.json() as T;
  }

  /**
   * Generic DELETE helper. Used by the studio/servers/agents/fixtures
   * delete commands. Returns parsed JSON (most delete endpoints respond
   * with `{ ok: true }` or a 204 — both are tolerated).
   */
  async delete<T>(path: string): Promise<T | null> {
    const ms = timeoutMs('MCPVERIFY_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      rethrowTimeoutOrOriginal(err, ms, 'Check MCPVERIFY_API_URL or your network.');
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `DELETE ${path} returned ${res.status}`);
    }
    return await res.json() as T;
  }

  /**
   * Generic PATCH helper. Used for partial updates (servers.update, agents.update).
   */
  async patch<T>(path: string, body: unknown = {}): Promise<T> {
    const ms = timeoutMs('MCPVERIFY_API_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}${path}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      rethrowTimeoutOrOriginal(err, ms, 'Check MCPVERIFY_API_URL or your network.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `PATCH ${path} returned ${res.status}`);
    }
    return await res.json() as T;
  }

  /**
   * Submit a trace for cloud scoring. Returns the runId + report URL.
   * The validation engine (proprietary) runs server-side and persists results.
   */
  async submitTrace(trace: TraceBundle): Promise<RunResult> {
    const ms = timeoutMs('MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS', SUBMIT_TRACE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/api/v1/runs/score`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': `mcpverify-sdk/${trace.sdkVersion}`,
        },
        body: JSON.stringify(trace),
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      rethrowTimeoutOrOriginal(
        err,
        ms,
        'Trace upload timed out. Try MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS=180000 on slow networks.',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `API returned ${res.status}`);
    }

    return await res.json() as RunResult;
  }

  /**
   * Open an SSE stream for live assertion results from a run.
   * Used by the CLI to print results as they arrive while the cloud scores.
   * NOTE: intentionally has NO timeout — SSE is long-lived. A stall detector
   * (no data for N seconds → abort) is a Phase 2.5 follow-up.
   */
  async streamResults(runId: string, onEvent: (evt: Record<string, unknown>) => void): Promise<void> {
    const url = `${this.apiUrl}/api/v1/runs/${runId}/stream`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, `Stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const block of events) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const evt = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          onEvent(evt);
          if (evt['type'] === 'stream_end') return;
        } catch {
          // ignore malformed lines
        }
      }
    }
  }
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function resolveApiKey(provided?: string): string {
  const key = provided ?? process.env['MCPVERIFY_API_KEY'];
  if (!key) {
    throw new Error(
      'Missing API key. Set MCPVERIFY_API_KEY env var or pass --api-key.\n' +
      'Get a key at https://app.mcpverify.dev/settings/api-keys',
    );
  }
  return key;
}
