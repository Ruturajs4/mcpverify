// Transport implementations.
//
// All transports expose the same shape so the probe sequence can drive any of them:
//   - request(method, params?, id?) -> Promise<unknown>      (waits for the matching response)
//   - notify(method, params?) -> void                          (no response expected)
//   - getMessages() -> ProtocolMessage[]                       (full trace, both directions)
//   - getStderr() -> string[]                                  (server-side fragments; HTTP transports return [])
//   - start() / stop()                                         (lifecycle)
//
// The cloud-side validation engine inspects the protocol trace; it does not care
// which transport produced it. Stdio, Streamable HTTP (2025-03-26), and legacy
// HTTP+SSE (2024-11-05) all yield interchangeable JSON-RPC traces.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ReadableStream, ReadableStreamDefaultReader } from 'node:stream/web';
import type { ProtocolMessage } from './types.js';

// Per-transport request timeout budgets.
//
// stdio:       3s  — local process should respond fast; PRO-001 latency assertion enforces this.
// http / sse:  10s — real cloud servers doing actual tool work need more headroom.
//                    With 3s here, every real-world cloud probe failed and the cloud reported them
//                    as critical failures via ProbeNotCapturedError. 10s eliminates most of those.
const STDIO_REQUEST_TIMEOUT_MS = 3_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;

type PendingRequest = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  outboundAtMs: number;
};

/**
 * Common contract that every transport implements. The probe sequence types
 * against this interface so that stdio, streamable HTTP, and legacy SSE
 * transports are all interchangeable.
 */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<{ exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null }>;
  request(method: string, params?: unknown, id?: string | number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  getMessages(): ProtocolMessage[];
  getStderr(): string[];
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

export class StdioTransport implements Transport {
  private proc: ChildProcess | null = null;
  private stopped = false;
  private exitPromise: Promise<number | null> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages: ProtocolMessage[] = [];
  private readonly stderrFragments: string[] = [];

  constructor(private readonly serverCommand: string) {}

  getMessages(): ProtocolMessage[] {
    return [...this.messages];
  }

  getStderr(): string[] {
    return [...this.stderrFragments];
  }

  async start(): Promise<void> {
    const tokens = this.serverCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const cmd = tokens[0]?.replace(/^["']|["']$/g, '');
    if (!cmd) throw new Error('Empty server command');
    const args = tokens.slice(1).map(t => t.replace(/^["']|["']$/g, ''));

    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx etc are .cmd on Windows
    });

    // Track the exit so stop() can await it reliably regardless of how it was killed.
    // Resolves once, even if listeners are attached after exit (Node caches `exitCode`).
    this.exitPromise = new Promise((resolve) => {
      const proc = this.proc!;
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
        return;
      }
      proc.once('exit', (code) => resolve(code));
    });

    // Swallow EPIPE on stdin so a server that exits early doesn't crash the host process.
    this.proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        // Still reject pending requests for non-EPIPE stdin errors.
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      }
    });

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => this.handleLine(line));
    // Stdout can emit ECONNRESET / EPIPE on abrupt child death; absorb here.
    this.proc.stdout?.on('error', () => { /* drained on exit */ });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const fragment = chunk.toString('utf8');
      this.stderrFragments.push(fragment);
    });
    this.proc.stderr?.on('error', () => { /* swallow */ });

    this.proc.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  /**
   * Capture the response to a synthesized JSON-RPC request.
   * Note: the request itself is recorded in `messages` so the cloud-side validation engine
   * can inspect both sides of the exchange.
   */
  request(method: string, params?: unknown, id?: string | number): Promise<unknown> {
    const reqId = id ?? randomUUID();
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: reqId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const line = JSON.stringify(envelope);
    const at = Date.now();

    this.messages.push({
      direction: 'out',
      timestampMs: at,
      payload: envelope,
    });

    if (this.stopped) {
      return Promise.reject(new Error('Transport stopped'));
    }
    if (!this.proc?.stdin || !this.proc.stdin.writable) {
      return Promise.reject(new Error('Server stdin is not writable'));
    }
    // write() returns false on backpressure but never throws synchronously for
    // EPIPE — the error fires on the stream's 'error' event (handled in start()).
    try {
      this.proc.stdin.write(line + '\n');
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    return new Promise((resolve, reject) => {
      this.pending.set(String(reqId), { resolve, reject, outboundAtMs: at });
      // PRO-001 latency budget: local stdio process should respond within 3s.
      setTimeout(() => {
        if (this.pending.has(String(reqId))) {
          this.pending.delete(String(reqId));
          reject(new Error(`Request "${method}" timed out after ${STDIO_REQUEST_TIMEOUT_MS / 1000}s`));
        }
      }, STDIO_REQUEST_TIMEOUT_MS);
    });
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.messages.push({
      direction: 'out',
      timestampMs: Date.now(),
      payload: envelope,
    });
    if (this.stopped) return;
    try {
      this.proc?.stdin?.write(JSON.stringify(envelope) + '\n');
    } catch { /* EPIPE if child died — surfaces on next request */ }
  }

  /**
   * Stop the child reliably. Idempotent; never throws.
   *
   * Cleanup order:
   *   1. Mark stopped + drain in-flight `request()` callers so they don't hang.
   *   2. Close stdin (lets a well-behaved server exit cleanly).
   *   3. Wait up to 2s for natural exit.
   *   4. SIGTERM (POSIX) / `taskkill /T /F` (Windows, recursive) the process tree.
   *      On win32 the child is wrapped in cmd.exe (shell: true above); plain
   *      proc.kill() only kills cmd.exe and leaves the grandchild node holding
   *      the stdio pipe — which is exactly the EPIPE accumulation we saw.
   *   5. Wait another 2s, then SIGKILL as a last resort.
   *   6. Null out `this.proc` so a leaked reference can't keep it alive.
   */
  async stop(): Promise<{ exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null }> {
    if (this.stopped) {
      return { exitedCleanly: true, exitedWithinMs: 0, exitCode: this.proc?.exitCode ?? null };
    }
    this.stopped = true;
    const startedAt = Date.now();
    const proc = this.proc;

    // Reject any pending request promises so awaiting callers unblock.
    const drainErr = new Error('Transport stopped');
    for (const [, p] of this.pending) {
      try { p.reject(drainErr); } catch { /* listener already gone */ }
    }
    this.pending.clear();

    if (!proc) {
      this.proc = null;
      return { exitedCleanly: false, exitedWithinMs: 0, exitCode: null };
    }

    // If the child already exited, we're done.
    if (proc.exitCode !== null) {
      const code = proc.exitCode;
      this.proc = null;
      return { exitedCleanly: true, exitedWithinMs: Date.now() - startedAt, exitCode: code };
    }

    // Politely close stdin first.
    try { proc.stdin?.end(); } catch { /* EPIPE possible — ignore */ }

    const waitForExit = (ms: number): Promise<number | null> =>
      Promise.race([
        this.exitPromise ?? Promise.resolve(null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);

    // Phase 1: grace period after stdin close.
    let code = await waitForExit(2_000);
    if (code !== null || proc.exitCode !== null) {
      this.proc = null;
      return { exitedCleanly: true, exitedWithinMs: Date.now() - startedAt, exitCode: code ?? proc.exitCode };
    }

    // Phase 2: terminate. On Windows the spawn used shell:true, so proc.kill()
    // only kills cmd.exe and leaves a grandchild node process holding the
    // stdio pipe. Use taskkill /T to walk the tree.
    killTree(proc);

    // Phase 3: wait for the tree to actually exit, then SIGKILL as last resort.
    code = await waitForExit(2_000);
    if (code === null && proc.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          killTree(proc, /*force*/ true);
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* already dead */ }
      code = await waitForExit(1_000);
    }

    const cleanly = code !== null || proc.exitCode !== null;
    this.proc = null;
    return {
      exitedCleanly: cleanly,
      exitedWithinMs: Date.now() - startedAt,
      exitCode: code ?? proc.exitCode ?? null,
    };
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Server emitted non-JSON on stdout — record for the cloud to flag (PRO-006).
      this.messages.push({
        direction: 'in',
        timestampMs: Date.now(),
        payload: { __mcpverify_invalid_json__: true, raw: line },
      });
      return;
    }

    const idVal = payload['id'];
    const id = typeof idVal === 'string' || typeof idVal === 'number' ? String(idVal) : undefined;
    const inboundAt = Date.now();

    let latencyMs: number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      latencyMs = inboundAt - p.outboundAtMs;
      this.pending.delete(id);
      if (payload['error'] !== undefined) p.reject(payload['error']);
      else p.resolve(payload['result'] ?? payload);
    }

    this.messages.push({
      direction: 'in',
      timestampMs: inboundAt,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      payload,
    });
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport — MCP 2025-03-26
// ---------------------------------------------------------------------------
//
// One single endpoint (`/mcp`). Each client→server message is a POST. The
// server picks how to reply:
//   - `Content-Type: application/json` → a single JSON-RPC response
//   - `Content-Type: text/event-stream` → an SSE stream containing one or
//     more JSON-RPC frames; we parse until the frame whose id matches arrives.
//
// Some servers also issue a `Mcp-Session-Id` header on initialize; we echo it
// back on subsequent requests if we observe one.

export class StreamableHttpTransport implements Transport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages: ProtocolMessage[] = [];
  private sessionId: string | null = null;
  private stopped = false;

  /**
   * @param url           Streamable HTTP endpoint (typically /mcp)
   * @param bearerToken   Optional OAuth 2.1 access token. Sent as `Authorization: Bearer <token>` on every request.
   * @param extraHeaders  Optional extra HTTP headers to append to every request. Authorization (managed by bearerToken) takes precedence on key conflict.
   * @param fetchImpl     Optional fetch override (T-162). When the SDK runs in
   *                      the cloud (probe-tools, diagnose), apps/web passes a
   *                      closure built by `makePinnedFetchImpl()` that wraps
   *                      undici fetch with per-call SSRF pinning + manual
   *                      redirect unfolding. CLI consumers omit the arg and
   *                      get the global `fetch` (no behavior change).
   *                      Kept as `typeof fetch` so the SDK stays
   *                      dependency-free — the caller owns the undici binding.
   */
  constructor(
    private readonly url: string,
    private readonly bearerToken?: string,
    private readonly extraHeaders?: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getMessages(): ProtocolMessage[] {
    return [...this.messages];
  }

  // HTTP transports have no local stderr to capture.
  getStderr(): string[] {
    return [];
  }

  async start(): Promise<void> {
    // Nothing to spin up; each request opens its own POST.
  }

  async stop(): Promise<{ exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null }> {
    this.stopped = true;
    // Reject any pending requests so callers don't hang.
    for (const [, p] of this.pending) {
      p.reject(new Error('Transport stopped'));
    }
    this.pending.clear();
    return { exitedCleanly: true, exitedWithinMs: 0, exitCode: 0 };
  }

  request(method: string, params?: unknown, id?: string | number): Promise<unknown> {
    const reqId = id ?? randomUUID();
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: reqId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const at = Date.now();

    this.messages.push({
      direction: 'out',
      timestampMs: at,
      payload: envelope,
    });

    return new Promise((resolve, reject) => {
      this.pending.set(String(reqId), { resolve, reject, outboundAtMs: at });

      const timer = setTimeout(() => {
        if (this.pending.has(String(reqId))) {
          this.pending.delete(String(reqId));
          reject(new Error(`Request "${method}" timed out after ${HTTP_REQUEST_TIMEOUT_MS / 1000}s`));
        }
      }, HTTP_REQUEST_TIMEOUT_MS);

      this.postAndConsume(envelope, String(reqId)).catch((err) => {
        clearTimeout(timer);
        if (this.pending.has(String(reqId))) {
          this.pending.delete(String(reqId));
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.messages.push({
      direction: 'out',
      timestampMs: Date.now(),
      payload: envelope,
    });
    // Fire and forget; per spec the server returns 202 Accepted with no body.
    this.postAndConsume(envelope, null).catch(() => { /* swallow */ });
  }

  /**
   * POST a single JSON-RPC frame. If the server replies with JSON, deliver it
   * directly. If the server replies with an SSE stream, parse it until we see
   * the frame matching `expectedId` (or the stream ends, for notifications).
   */
  private async postAndConsume(envelope: Record<string, unknown>, expectedId: string | null): Promise<void> {
    if (this.stopped) throw new Error('Transport stopped');

    // Custom headers come first; auth and session-managed headers override on conflict.
    const headers: Record<string, string> = { ...(this.extraHeaders ?? {}) };
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json, text/event-stream';
    headers['User-Agent'] = 'MCPVerify-SDK/0.2.0 (+https://mcpverify.dev)';
    if (this.bearerToken) headers['Authorization'] = `Bearer ${this.bearerToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
    });

    // Capture session id if the server issues one (initialize handshake).
    const sid = res.headers.get('mcp-session-id');
    if (sid && !this.sessionId) this.sessionId = sid;

    // 202 Accepted with no body (typical for notifications).
    if (res.status === 202 || res.headers.get('content-length') === '0') {
      return;
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();

    if (ct.includes('application/json')) {
      const text = await res.text();
      if (!text.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.messages.push({
          direction: 'in',
          timestampMs: Date.now(),
          payload: { __mcpverify_invalid_json__: true, raw: text },
        });
        return;
      }
      // Some servers batch responses into an array.
      if (Array.isArray(parsed)) {
        for (const frame of parsed) this.handlePayload(frame as Record<string, unknown>);
      } else {
        this.handlePayload(parsed as Record<string, unknown>);
      }
      return;
    }

    if (ct.includes('text/event-stream') && res.body) {
      await this.consumeSse(res.body, expectedId);
      return;
    }

    // Unknown content type — record what we got so the engine can flag it.
    const raw = await res.text().catch(() => '');
    this.messages.push({
      direction: 'in',
      timestampMs: Date.now(),
      payload: {
        __mcpverify_unexpected_content_type__: true,
        contentType: ct,
        status: res.status,
        raw,
      },
    });

    // FAST-FAIL on 4xx/5xx with non-JSON body. Without this, plain-text error
    // responses (nginx `Unauthorized`, WAF blocks, upstream 401, etc.)
    // tarpit the pending request until the 10s request-timeout fires. Callers
    // get a misleading "didn't respond in time" instead of the real status.
    if (expectedId !== null && res.status >= 400) {
      const pending = this.pending.get(expectedId);
      if (pending) {
        this.pending.delete(expectedId);
        const excerpt = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
        pending.reject(
          new Error(
            `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''} from MCP endpoint`
              + (excerpt ? `: ${excerpt}` : ''),
          ),
        );
      }
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>, expectedId: string | null): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Events are separated by a blank line.
        let sepIdx: number;
        while ((sepIdx = buf.indexOf('\n\n')) !== -1 || (sepIdx = buf.indexOf('\r\n\r\n')) !== -1) {
          const eventBlock = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + (buf[sepIdx + 1] === '\r' ? 4 : 2));
          const frame = parseSseEvent(eventBlock);
          if (frame.data === null) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            this.messages.push({
              direction: 'in',
              timestampMs: Date.now(),
              payload: { __mcpverify_invalid_json__: true, raw: frame.data },
            });
            continue;
          }

          const frames = Array.isArray(parsed) ? parsed : [parsed];
          for (const f of frames) {
            const handled = this.handlePayload(f as Record<string, unknown>);
            if (expectedId !== null && handled === expectedId) {
              // Drain the rest of the stream in the background — but we have
              // what we came for, so close the reader now to free the socket.
              try { await reader.cancel(); } catch { /* ignore */ }
              return;
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  /**
   * Record an inbound JSON-RPC frame. Returns the id (as string) if the frame
   * resolved a pending request, else null.
   */
  private handlePayload(payload: Record<string, unknown>): string | null {
    const idVal = payload['id'];
    const id = typeof idVal === 'string' || typeof idVal === 'number' ? String(idVal) : undefined;
    const inboundAt = Date.now();

    let latencyMs: number | undefined;
    let resolvedId: string | null = null;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      latencyMs = inboundAt - p.outboundAtMs;
      this.pending.delete(id);
      resolvedId = id;
      if (payload['error'] !== undefined) p.reject(payload['error']);
      else p.resolve(payload['result'] ?? payload);
    }

    this.messages.push({
      direction: 'in',
      timestampMs: inboundAt,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      payload,
    });
    return resolvedId;
  }
}

// ---------------------------------------------------------------------------
// Legacy HTTP+SSE transport — MCP 2024-11-05
// ---------------------------------------------------------------------------
//
// Two channels:
//   1. A long-lived GET to `/sse` that streams server→client frames.
//   2. A short-lived POST per client→server frame to a URL the server
//      announces in its first SSE event (`event: endpoint`, `data: <url>`).
//
// We open the GET stream lazily on the first request() call and keep it open
// for the life of the transport. Responses arrive on the GET stream and are
// matched to outstanding requests by id.

export class SseTransport implements Transport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages: ProtocolMessage[] = [];
  private messageUrl: string | null = null;
  private endpointReady: Promise<void> | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamAbort: AbortController | null = null;
  private stopped = false;

  /**
   * @param url           Legacy GET /sse endpoint URL
   * @param bearerToken   Optional OAuth 2.1 access token. Sent on both the SSE GET and POST message URL.
   * @param extraHeaders  Optional extra HTTP headers appended to every request (GET stream + POST messages).
   * @param fetchImpl     Optional fetch override (T-162). See StreamableHttpTransport
   *                      for the rationale. CLI consumers omit and get global fetch.
   */
  constructor(
    private readonly url: string,
    private readonly bearerToken?: string,
    private readonly extraHeaders?: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getMessages(): ProtocolMessage[] {
    return [...this.messages];
  }

  getStderr(): string[] {
    return [];
  }

  async start(): Promise<void> {
    // Connection is opened lazily on the first request so probe failures
    // surface as request errors rather than start() errors.
  }

  async stop(): Promise<{ exitedCleanly: boolean; exitedWithinMs: number; exitCode: number | null }> {
    this.stopped = true;
    try { this.streamAbort?.abort(); } catch { /* ignore */ }
    try { await this.streamReader?.cancel(); } catch { /* ignore */ }
    for (const [, p] of this.pending) p.reject(new Error('Transport stopped'));
    this.pending.clear();
    return { exitedCleanly: true, exitedWithinMs: 0, exitCode: 0 };
  }

  request(method: string, params?: unknown, id?: string | number): Promise<unknown> {
    const reqId = id ?? randomUUID();
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: reqId,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const at = Date.now();

    this.messages.push({
      direction: 'out',
      timestampMs: at,
      payload: envelope,
    });

    return new Promise((resolve, reject) => {
      this.pending.set(String(reqId), { resolve, reject, outboundAtMs: at });

      const timer = setTimeout(() => {
        if (this.pending.has(String(reqId))) {
          this.pending.delete(String(reqId));
          reject(new Error(`Request "${method}" timed out after ${HTTP_REQUEST_TIMEOUT_MS / 1000}s`));
        }
      }, HTTP_REQUEST_TIMEOUT_MS);

      this.send(envelope).catch((err) => {
        clearTimeout(timer);
        if (this.pending.has(String(reqId))) {
          this.pending.delete(String(reqId));
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const envelope: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.messages.push({
      direction: 'out',
      timestampMs: Date.now(),
      payload: envelope,
    });
    this.send(envelope).catch(() => { /* swallow */ });
  }

  private async send(envelope: Record<string, unknown>): Promise<void> {
    if (this.stopped) throw new Error('Transport stopped');
    await this.ensureEndpoint();
    if (!this.messageUrl) throw new Error('No SSE endpoint announced by server');

    const postHeaders: Record<string, string> = { ...(this.extraHeaders ?? {}) };
    postHeaders['Content-Type'] = 'application/json';
    postHeaders['User-Agent'] = 'MCPVerify-SDK/0.2.0 (+https://mcpverify.dev)';
    if (this.bearerToken) postHeaders['Authorization'] = `Bearer ${this.bearerToken}`;
    const res = await this.fetchImpl(this.messageUrl, {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify(envelope),
    });
    // The legacy spec returns 202 Accepted; the response itself comes via SSE.
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${this.messageUrl} failed: ${res.status} ${text}`);
    }
    // Drain body to free the connection — we don't expect a useful payload here.
    try { await res.text(); } catch { /* ignore */ }
  }

  private ensureEndpoint(): Promise<void> {
    if (this.endpointReady) return this.endpointReady;
    this.endpointReady = this.openStream();
    return this.endpointReady;
  }

  private async openStream(): Promise<void> {
    this.streamAbort = new AbortController();
    const getHeaders: Record<string, string> = { ...(this.extraHeaders ?? {}) };
    getHeaders['Accept'] = 'text/event-stream';
    getHeaders['User-Agent'] = 'MCPVerify-SDK/0.2.0 (+https://mcpverify.dev)';
    if (this.bearerToken) getHeaders['Authorization'] = `Bearer ${this.bearerToken}`;
    const res = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: getHeaders,
      signal: this.streamAbort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to open SSE stream at ${this.url}: ${res.status}`);
    }
    const reader = res.body.getReader();
    this.streamReader = reader;

    // Wait for the `endpoint` event before resolving so callers can POST.
    const endpointPromise = new Promise<void>((resolve, reject) => {
      this.endpointResolver = resolve;
      this.endpointRejector = reject;
    });

    // Pump the stream in the background.
    void this.pump(reader);
    await endpointPromise;
  }

  private endpointResolver: (() => void) | null = null;
  private endpointRejector: ((e: Error) => void) | null = null;

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let sepIdx: number;
        while ((sepIdx = buf.indexOf('\n\n')) !== -1 || (sepIdx = buf.indexOf('\r\n\r\n')) !== -1) {
          const eventBlock = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + (buf[sepIdx + 1] === '\r' ? 4 : 2));
          const frame = parseSseEvent(eventBlock);
          if (frame.data === null) continue;

          if (frame.event === 'endpoint') {
            // Per spec: data is the message URL, possibly relative.
            this.messageUrl = resolveUrl(this.url, frame.data.trim());
            this.endpointResolver?.();
            this.endpointResolver = null;
            this.endpointRejector = null;
            continue;
          }

          // Default event type for JSON-RPC frames is 'message'.
          let parsed: unknown;
          try {
            parsed = JSON.parse(frame.data);
          } catch {
            this.messages.push({
              direction: 'in',
              timestampMs: Date.now(),
              payload: { __mcpverify_invalid_json__: true, raw: frame.data },
            });
            continue;
          }
          const frames = Array.isArray(parsed) ? parsed : [parsed];
          for (const f of frames) this.handlePayload(f as Record<string, unknown>);
        }
      }
    } catch (err) {
      // If we never got an endpoint event, fail the start().
      if (this.endpointRejector) {
        this.endpointRejector(err instanceof Error ? err : new Error(String(err)));
        this.endpointRejector = null;
        this.endpointResolver = null;
      }
    } finally {
      // Reject anything still waiting; the stream is gone.
      for (const [, p] of this.pending) p.reject(new Error('SSE stream closed'));
      this.pending.clear();
    }
  }

  private handlePayload(payload: Record<string, unknown>): void {
    const idVal = payload['id'];
    const id = typeof idVal === 'string' || typeof idVal === 'number' ? String(idVal) : undefined;
    const inboundAt = Date.now();

    let latencyMs: number | undefined;
    if (id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      latencyMs = inboundAt - p.outboundAtMs;
      this.pending.delete(id);
      if (payload['error'] !== undefined) p.reject(payload['error']);
      else p.resolve(payload['result'] ?? payload);
    }

    this.messages.push({
      direction: 'in',
      timestampMs: inboundAt,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      payload,
    });
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SseFrame { event: string; data: string | null; id: string | null }

function parseSseEvent(block: string): SseFrame {
  let event = 'message';
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let val = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'event') event = val;
    else if (field === 'data') dataLines.push(val);
    else if (field === 'id') id = val;
  }
  return {
    event,
    data: dataLines.length === 0 ? null : dataLines.join('\n'),
    id,
  };
}

function resolveUrl(base: string, candidate: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// Process-tree termination
// ---------------------------------------------------------------------------
//
// StdioTransport spawns with `shell: true` on Windows so `npx`/`.cmd` shims
// resolve. That wraps the user's MCP server in a `cmd.exe` parent; calling
// child.kill() only signals cmd.exe and orphans the grandchild Node process,
// which keeps the stdio pipe open. Across dozens of test runs the orphans
// accumulate and the dev server starts EPIPE-ing on stdin writes (the kernel
// has run out of pipe slots / the Node side closed the writable half).
//
// On Windows we shell out to `taskkill /T` to walk the tree. On POSIX we
// SIGTERM (then SIGKILL) directly on the process — `shell: true` is only set
// for win32 so the grandchild problem doesn't apply there.
function killTree(proc: ChildProcess, force = false): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      // /T = tree, /F = force. /F is recommended when /T is used because
      // cmd.exe doesn't propagate the polite signal anyway.
      spawnSync('taskkill', ['/PID', String(pid), '/T', force ? '/F' : '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* tree already gone */ }
    return;
  }
  try {
    proc.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch { /* already dead */ }
}
