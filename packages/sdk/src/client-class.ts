// McpVerifyClient — ergonomic namespaced API for programmatic SDK consumers.
//
// Thin wrapper over CloudClient.{get,post,delete,patch} + the module-level
// run/runSuiteLocal/runDiagnose functions. Existing module-level exports
// stay exported — this class is purely additive.
//
//   import { McpVerifyClient } from '@mcp-verify/sdk';
//   const client = new McpVerifyClient({ apiKey: process.env.MCPVERIFY_API_KEY! });
//   await client.compliance.run({ transport: 'http', url: '...' });
//   await client.automation.fixtures.list();
//   await client.servers.probe(serverId);

import { run, type RunOptions, type RunResult } from './index.js';
import { runDiagnose, type DiagnoseTarget, type DiagnoseResult } from './diagnose.js';
import { CloudClient } from './client.js';

export interface McpVerifyClientOptions {
  /** Resolved from MCPVERIFY_API_KEY env var when omitted. */
  apiKey?: string;
  /** Defaults to https://api.mcpverify.dev. */
  apiUrl?: string;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface AuthMeResult {
  user: { id: string; email: string; name: string | null };
  actor: { type: 'user' | 'api_key'; id: string };
}

export interface ComplianceRunSummary {
  id: string;
  server: string;
  mode: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: number;
  completed_at: number | null;
  total: number;
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  auth_state: string | null;
}

export interface ComplianceRunDetail extends ComplianceRunSummary {
  assertions: Array<{
    id: number;
    assertion_id: string;
    surface: string;
    severity: string;
    verdict: 'pass' | 'fail' | 'warn' | 'skip';
    observed: string | null;
    expected: string | null;
    error: string | null;
    remediation: string | null;
  }>;
}

/** Cross-server × assertion-id pass/fail aggregation derived from listRuns. */
export interface ComplianceMatrixCell {
  server: string;
  total_runs: number;
  last_run_at: number | null;
  last_verdict: 'pass' | 'fail' | 'partial';
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  pass_rate: number; // 0..1
}

/**
 * Result of `client.compliance.matrix()`. The aggregation is computed
 * client-side from the last N runs; `truncated` signals whether the window
 * was saturated (i.e. there are more runs than `window_size` and the cells
 * are an incomplete rollup). Consumers should render the truncation
 * affordance to keep numbers honest against the web matrix view.
 *
 * Red Flags Bundle Phase C (2026-05-26): added so CLI users with >100 runs
 * stop seeing silently-incomplete numbers.
 */
export interface MatrixResult {
  cells: ComplianceMatrixCell[];
  truncated: boolean;
  window_size: number;
}

export interface SuiteSummary {
  id: string;
  name: string;
  description: string | null;
  case_count: number;
  server_id: string | null;
  last_run_at: number | null;
  last_verdict: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Result of `automation.listSuitesWithMeta()`. The list endpoint is
 * bounded at 100 suites; `total` lets the CLI/UI render a
 * "Showing N of M" affordance when the count exceeds the page size.
 *
 * Red Flags Bundle Phase D (2026-05-26).
 */
export interface SuiteListResult {
  suites: SuiteSummary[];
  total: number;
}

export interface CreateSuiteInput {
  name: string;
  description?: string;
  serverId: string;
}

export interface CreateCaseInput {
  suiteId: string;
  name: string;
  kind: 'scripted' | 'agentic';
  yaml: string;
  description?: string;
}

export interface CaseSummary {
  id: string;
  suite_id: string;
  name: string;
  description: string | null;
  kind: 'scripted' | 'agentic';
  created_at: number;
  updated_at: number;
}

export interface FixtureSummary {
  name: string;
  kind: 'variable' | 'static' | 'secret' | 'dynamic-http';
  created_at: number;
  updated_at: number;
  ttl_seconds: number | null;
  source: { method: string; url: string; extract: string } | null;
  has_teardown: boolean;
}

export interface CreateDynamicHttpFixtureInput {
  name: string;
  source: Record<string, unknown>;
  teardown?: Record<string, unknown>;
  ttlSeconds: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  model: string;
  base_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider:
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'mistral'
    | 'bedrock'
    | 'vertex'
    | 'azure-openai'
    | 'openai-compatible';
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http' | 'sse';
  url: string | null;
  command: string | null;
  /** Free-form environment label (e.g. "prod", "staging"). */
  env_tag: string | null;
  /** Headers stored on the server entry — applied automatically when --server-id is used. */
  default_headers: Record<string, string> | null;
  /** OAuth scopes stored on the server entry. */
  default_scopes: string[] | null;
  /** 'none' | 'bearer' | 'oauth' — the SDK uses this as a hint, never the secret. */
  default_auth_kind: 'none' | 'bearer' | 'oauth' | null;
  auth_state: string | null;
  last_probed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateServerInput {
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
  command?: string;
  envTag?: string;
  defaultHeaders?: Record<string, string>;
  defaultScopes?: string[];
  defaultAuthKind?: 'none' | 'bearer' | 'oauth';
  defaultAuthBearer?: string;
}

export type UpdateServerInput = Partial<CreateServerInput>;

export interface ProbeResult {
  ok: boolean;
  auth_state: string | null;
  tool_count: number | null;
  error: string | null;
}

export interface CaseRunResult {
  runId: string;
  status: string;
  verdict: string | null;
  confidence: number | null;
  reasoning: string | null;
  latencyMs: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class McpVerifyClient {
  private readonly cloud: CloudClient;

  constructor(opts: McpVerifyClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env['MCPVERIFY_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'McpVerifyClient requires apiKey. Set MCPVERIFY_API_KEY env var or pass { apiKey } to the constructor.\n' +
        'Get a key at https://app.mcpverify.dev/settings/api-keys',
      );
    }
    this.cloud = new CloudClient(apiKey, opts.apiUrl);
  }

  /** Identity / api-key validation. */
  readonly auth = {
    whoami: (): Promise<AuthMeResult> => {
      return this.cloud.get<AuthMeResult>('/api/v1/auth/me');
    },
  };

  /** The 89-assertion protocol-compliance surface. */
  readonly compliance = {
    run: (opts: Omit<RunOptions, 'apiKey' | 'apiUrl'>): Promise<RunResult> => {
      return run({ ...opts, apiKey: this.cloud.apiKey, apiUrl: this.cloud.apiUrl });
    },
    listRuns: (opts: { limit?: number } = {}): Promise<ComplianceRunSummary[]> => {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
      return this.cloud.get<ComplianceRunSummary[]>(`/api/v1/compliance/runs?limit=${limit}`);
    },
    getRun: (runId: string): Promise<ComplianceRunDetail> => {
      return this.cloud.get<ComplianceRunDetail>(`/api/v1/compliance/runs/${encodeURIComponent(runId)}`);
    },
    deleteRun: (runId: string): Promise<void> => {
      return this.cloud
        .delete(`/api/v1/compliance/runs/${encodeURIComponent(runId)}`)
        .then(() => undefined);
    },
    /**
     * SSE stream of a compliance run's per-assertion events. Resolves when
     * the cloud emits `{ type: 'stream_end' }`. Use for tailing an in-progress
     * run from `mcpverify compliance runs stream <id>`.
     */
    streamRun: (
      runId: string,
      onEvent: (evt: Record<string, unknown>) => void,
    ): Promise<void> => {
      return this.cloud.streamResults(runId, onEvent);
    },
    /**
     * Cross-server matrix view. Derived client-side from listRuns — collapses
     * recent runs into per-server pass/fail aggregates. Use `limit` to widen
     * the window (default = last 100 runs, the cloud cap).
     *
     * Red Flags Bundle Phase C: returns `{cells, truncated, window_size}` so
     * the CLI can render a truncation footer when the window is saturated
     * (i.e. there are more runs than the limit and the aggregates are an
     * incomplete rollup). Previously returned `Cell[]` directly — that shape
     * is gone since the only consumer was the local CLI (the npm-published
     * SDK at v0.3.0 didn't expose matrix() at all).
     */
    matrix: async (opts: { limit?: number } = {}): Promise<MatrixResult> => {
      const window = opts.limit ?? 100;
      const runs = await this.compliance.listRuns({ limit: window });
      const byServer = new Map<string, ComplianceRunSummary[]>();
      for (const r of runs) {
        if (!byServer.has(r.server)) byServer.set(r.server, []);
        byServer.get(r.server)!.push(r);
      }
      const cells: ComplianceMatrixCell[] = [];
      for (const [server, list] of byServer) {
        const passed = list.reduce((a, r) => a + r.passed, 0);
        const failed = list.reduce((a, r) => a + r.failed, 0);
        const warned = list.reduce((a, r) => a + r.warned, 0);
        const skipped = list.reduce((a, r) => a + r.skipped, 0);
        const denom = passed + failed + warned;
        const last = list[0]!; // listRuns is started_at DESC
        cells.push({
          server,
          total_runs: list.length,
          last_run_at: last.started_at,
          last_verdict:
            last.failed === 0 && last.warned === 0
              ? 'pass'
              : last.passed === 0
                ? 'fail'
                : 'partial',
          passed,
          failed,
          warned,
          skipped,
          pass_rate: denom > 0 ? passed / denom : 0,
        });
      }
      // Sort by last_run_at DESC so most-recently-tested servers appear first.
      cells.sort((a, b) => (b.last_run_at ?? 0) - (a.last_run_at ?? 0));
      return {
        cells,
        truncated: runs.length === window,
        window_size: window,
      };
    },
  };

  /** Assert Studio custom-test surface. */
  readonly automation = {
    // ---- Top-level conveniences (kept stable from v0.3.0) -----------------
    listSuites: (): Promise<SuiteSummary[]> => {
      return this.cloud
        .get<{ suites: SuiteSummary[] }>('/api/v1/studio/suites')
        .then((r) => r.suites);
    },
    /**
     * Same endpoint as `listSuites()` but returns the full `{suites, total}`
     * shape so consumers can render a "Showing N of M" affordance when the
     * list endpoint truncates at 100 rows.
     *
     * Red Flags Bundle Phase D (2026-05-26).
     */
    listSuitesWithMeta: (): Promise<SuiteListResult> => {
      return this.cloud.get<SuiteListResult>('/api/v1/studio/suites');
    },
    // runSuite() was removed in sdk@0.7.0 (T-184) with the legacy local
    // suite-runner. The new cloud-eval-runner is added later in this PR; the
    // method returns once it's wired up.
    runCase: (caseId: string): Promise<CaseRunResult> => {
      return this.cloud.post<CaseRunResult>(
        `/api/v1/studio/cases/${encodeURIComponent(caseId)}/run`,
        {},
      );
    },

    // ---- Suite CRUD (Phase 2) -------------------------------------------
    suites: {
      list: (): Promise<SuiteSummary[]> => {
        return this.cloud
          .get<{ suites: SuiteSummary[] }>('/api/v1/studio/suites')
          .then((r) => r.suites);
      },
      create: (input: CreateSuiteInput): Promise<SuiteSummary> => {
        return this.cloud
          .post<{ suite: SuiteSummary }>('/api/v1/studio/suites', {
            name: input.name,
            description: input.description,
            server_id: input.serverId,
          })
          .then((r) => r.suite);
      },
      delete: (suiteId: string): Promise<void> => {
        return this.cloud
          .delete(`/api/v1/studio/suites/${encodeURIComponent(suiteId)}`)
          .then(() => undefined);
      },
    },

    // ---- Case CRUD (Phase 2) --------------------------------------------
    cases: {
      create: (input: CreateCaseInput): Promise<CaseSummary> => {
        return this.cloud
          .post<{ case: CaseSummary }>(
            `/api/v1/studio/suites/${encodeURIComponent(input.suiteId)}/cases`,
            {
              name: input.name,
              description: input.description,
              kind: input.kind,
              yaml: input.yaml,
            },
          )
          .then((r) => r.case);
      },
      delete: (caseId: string): Promise<void> => {
        return this.cloud
          .delete(`/api/v1/studio/cases/${encodeURIComponent(caseId)}`)
          .then(() => undefined);
      },
    },

    // ---- Fixtures (Phase 2) ---------------------------------------------
    fixtures: {
      list: (): Promise<FixtureSummary[]> => {
        return this.cloud
          .get<{ fixtures: FixtureSummary[] }>('/api/v1/studio/fixtures')
          .then((r) => r.fixtures);
      },
      createVariable: (name: string, value: string): Promise<FixtureSummary> => {
        return this.cloud.post<FixtureSummary>('/api/v1/studio/fixtures', {
          name,
          kind: 'variable',
          value,
        });
      },
      createSecret: (name: string, value: string): Promise<FixtureSummary> => {
        return this.cloud.post<FixtureSummary>('/api/v1/studio/fixtures', {
          name,
          kind: 'secret',
          value,
        });
      },
      createDynamicHttp: (input: CreateDynamicHttpFixtureInput): Promise<FixtureSummary> => {
        return this.cloud.post<FixtureSummary>('/api/v1/studio/fixtures', {
          name: input.name,
          kind: 'dynamic-http',
          source: input.source,
          teardown: input.teardown,
          ttlSeconds: input.ttlSeconds,
        });
      },
      delete: (name: string): Promise<void> => {
        return this.cloud
          .delete(`/api/v1/studio/fixtures/${encodeURIComponent(name)}`)
          .then(() => undefined);
      },
    },

    // ---- Agents / LLM-as-judge credentials (Phase 2) --------------------
    agents: {
      list: (): Promise<AgentSummary[]> => {
        return this.cloud
          .get<{ agents: AgentSummary[] }>('/api/v1/agents')
          .then((r) => r.agents);
      },
      create: (input: CreateAgentInput): Promise<AgentSummary> => {
        return this.cloud
          .post<{ agent: AgentSummary }>('/api/v1/agents', {
            name: input.name,
            description: input.description,
            provider: input.provider,
            model: input.model,
            base_url: input.baseUrl,
            api_key: input.apiKey,
          })
          .then((r) => r.agent);
      },
      delete: (agentId: string): Promise<void> => {
        return this.cloud
          .delete(`/api/v1/agents/${encodeURIComponent(agentId)}`)
          .then(() => undefined);
      },
    },
  };

  /** The 5-layer diagnose connectivity probe. */
  readonly diagnose = {
    run: (target: DiagnoseTarget): Promise<DiagnoseResult> => {
      return runDiagnose({
        target,
        apiKey: this.cloud.apiKey,
        apiUrl: this.cloud.apiUrl,
      });
    },
  };

  /** Registered MCP server entries (the first-class T-181 servers table). */
  readonly servers = {
    list: (): Promise<ServerSummary[]> => {
      return this.cloud
        .get<{ servers: ServerSummary[] }>('/api/v1/servers')
        .then((r) => r.servers);
    },
    /**
     * Fetch a single server by id. Returns the public projection — encrypted
     * auth columns (`default_auth_ciphertext`, `_iv`, `_authtag`) are NEVER
     * surfaced. Useful for `compliance run --server-id <id>` to resolve
     * transport / url / command / default_headers / default_scopes from a
     * stored entry without re-typing them.
     */
    get: (serverId: string): Promise<ServerSummary> => {
      return this.cloud
        .get<{ server: ServerSummary }>(`/api/v1/servers/${encodeURIComponent(serverId)}`)
        .then((r) => r.server);
    },
    create: (input: CreateServerInput): Promise<ServerSummary> => {
      const body: Record<string, unknown> = {
        name: input.name,
        description: input.description,
        transport: input.transport,
        url: input.url,
        command: input.command,
        env_tag: input.envTag,
        default_headers: input.defaultHeaders,
        default_scopes: input.defaultScopes,
        default_auth_kind: input.defaultAuthKind,
        default_auth_bearer: input.defaultAuthBearer,
      };
      // Strip undefineds so zod's `.optional()` doesn't reject explicit nulls.
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      return this.cloud
        .post<{ server: ServerSummary }>('/api/v1/servers', body)
        .then((r) => r.server);
    },
    update: (serverId: string, patch: UpdateServerInput): Promise<ServerSummary> => {
      const body: Record<string, unknown> = {
        name: patch.name,
        description: patch.description,
        transport: patch.transport,
        url: patch.url,
        command: patch.command,
        env_tag: patch.envTag,
        default_headers: patch.defaultHeaders,
        default_scopes: patch.defaultScopes,
        default_auth_kind: patch.defaultAuthKind,
        default_auth_bearer: patch.defaultAuthBearer,
      };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      return this.cloud
        .patch<{ server: ServerSummary }>(
          `/api/v1/servers/${encodeURIComponent(serverId)}`,
          body,
        )
        .then((r) => r.server);
    },
    delete: (serverId: string): Promise<void> => {
      return this.cloud
        .delete(`/api/v1/servers/${encodeURIComponent(serverId)}`)
        .then(() => undefined);
    },
    probe: (serverId: string): Promise<ProbeResult> => {
      return this.cloud.post<ProbeResult>(
        `/api/v1/servers/${encodeURIComponent(serverId)}/probe`,
        {},
      );
    },
  };
}
