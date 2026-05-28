// Assert Studio — shared Zod schema for test definitions, fixtures, run results.
// This file is the contract between authoring (YAML editor), persistence (DB),
// and execution (scripted + agentic runners).
//
// Spec: docs/specs/E-10-assert-studio.md
// T-144: path-based AssertionExpr DSL + per-step assertions (schemaVersion: 2).

import { z } from 'zod';
import { translateLegacy } from './compat.js';

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

export const TransportSchema = z.enum(['stdio', 'http', 'sse']);
export type Transport = z.infer<typeof TransportSchema>;

export const ClientProfileSchema = z.enum([
  'generic',
  'claude-desktop',
  'cursor',
  'cline',
  'continue',
  'zed',
]);
export type ClientProfile = z.infer<typeof ClientProfileSchema>;

export const LLMProviderSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'mistral',
  'bedrock',
  'vertex',
  'azure-openai',
  'openai-compatible', // Ollama, Groq, Together, Anyscale, etc.
]);
export type LLMProvider = z.infer<typeof LLMProviderSchema>;

// Fixtures are referenced by name. Their values resolve at runtime — the LLM
// agent never sees the raw fixture material (founder Q2 decision).
export const FixtureRefSchema = z.object({
  fixture: z.string().min(1).max(64),
});
export type FixtureRef = z.infer<typeof FixtureRefSchema>;

// ---------------------------------------------------------------------------
// T-146 — Dynamic HTTP fixture source + teardown
// ---------------------------------------------------------------------------
//
// A dynamic-HTTP fixture executes an HTTP request against a setup endpoint,
// extracts a value from the JSON response via JSONPath, and caches that value
// for `ttl_seconds`. Subsequent resolves within the TTL window return the
// cached value without re-firing the source request. After the test run
// completes, an optional teardown request fires once per fixture per suite-run
// to clean up the upstream resource (e.g. DELETE the provisioned session).
//
// Wire-format kept dialect-free so the same shape powers the future
// `mcp-tool` flavor (T-156 backlog).

export const DynamicHttpFixtureSourceSchema = z.object({
  type: z.literal('http'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  /** JSONPath into the parsed JSON response — the extracted value is what gets cached. */
  extract: z.string().min(1),
  /** Optional bearer fixture to attach to the source call itself (resolved recursively). */
  authFixture: z.string().min(1).optional(),
});
export type DynamicHttpFixtureSource = z.infer<typeof DynamicHttpFixtureSourceSchema>;

export const FixtureTeardownSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** URL may contain the literal `{{value}}` token, replaced with the cached value at fire-time. */
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  authFixture: z.string().min(1).optional(),
});
export type FixtureTeardown = z.infer<typeof FixtureTeardownSchema>;

// ---------------------------------------------------------------------------
// Target — the MCP server under test
// ---------------------------------------------------------------------------

export const TargetSchema = z.object({
  transport: TransportSchema,
  url: z.string().url().optional(),
  command: z.string().optional(),
  auth: z
    .union([
      z.object({ type: z.literal('none') }),
      z.object({ type: z.literal('bearer'), fixture: z.string() }),
      z.object({ type: z.literal('header'), name: z.string(), fixture: z.string() }),
    ])
    .optional(),
});
export type Target = z.infer<typeof TargetSchema>;

// ---------------------------------------------------------------------------
// Setup — pre-run fixtures (static or dynamic)
// ---------------------------------------------------------------------------

export const SetupStepSchema = FixtureRefSchema;
export type SetupStep = z.infer<typeof SetupStepSchema>;

// ---------------------------------------------------------------------------
// AssertionExpr — the path-based DSL (T-144)
// ---------------------------------------------------------------------------
//
// 12 operators. The first 11 are deterministic (pure functions over actual
// response + bindings). The 12th, `semantic`, makes a BYO-key LLM call.
//
// Every operator may carry a top-level `message?: string` for a human-readable
// label that surfaces in the run-detail UI.

// Schema for an LLM judge configuration (semantic operator only).
//
// `keyFixture` is OPTIONAL: when the case has a bound agent
// (test_cases.agent_id), the dispatch/run routes inject the agent's
// decrypted credentials so the assertion doesn't need a separate fixture.
// The schema-level default of '' is sentinel — the runtime treats empty
// keyFixture as "use the agent's key", and falls back to a real fixture
// only when both empty AND no agent is bound (the legacy YAML path).
//
// provider/model on the judge override the agent's provider/model when
// non-empty; otherwise the agent's values are used.
export const JudgeConfigSchema = z.object({
  provider: LLMProviderSchema.optional(),
  model: z.string().min(1).optional(),
  keyFixture: z.string().optional().default(''),
  baseUrl: z.string().url().optional(),
});
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

export const AssertionExprSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('exists'),
    path: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('notExists'),
    path: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('equals'),
    path: z.string().min(1),
    value: z.unknown(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('notEquals'),
    path: z.string().min(1),
    value: z.unknown(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('contains'),
    path: z.string().min(1),
    // string-contains for strings, array-includes for arrays.
    value: z.unknown(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('length'),
    path: z.string().min(1),
    // length of array OR string.
    value: z.number().int().min(0),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('oneOf'),
    path: z.string().min(1),
    value: z.array(z.unknown()).min(1),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('jsonpath'),
    path: z.string().min(1),
    match: z.enum(['exists', 'count']),
    count: z.number().int().min(0).optional(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('regex'),
    path: z.string().min(1),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('schema'),
    // Schema is structural — defaults to root document.
    path: z.string().default('$'),
    schema: z.record(z.unknown()),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('latency'),
    lt: z.number().positive().optional(),
    gt: z.number().positive().optional(),
    message: z.string().optional(),
  }),
  z.object({
    op: z.literal('semantic'),
    rubric: z.string().min(10),
    judge: JudgeConfigSchema,
    message: z.string().optional(),
  }),
]);
export type AssertionExpr = z.infer<typeof AssertionExprSchema>;

// ---------------------------------------------------------------------------
// Scripted-mode steps
// ---------------------------------------------------------------------------

export const ScriptedStepSchema = z.object({
  kind: z.enum(['tools/call', 'prompts/get', 'resources/read']),
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  bind: z.string().optional(), // output bound to a variable for downstream steps
  // T-144: per-step assertions are now first-class.
  assertions: z.array(AssertionExprSchema).default([]),
});
export type ScriptedStep = z.infer<typeof ScriptedStepSchema>;

// ---------------------------------------------------------------------------
// Agentic-mode config
// ---------------------------------------------------------------------------

export const AgentConfigSchema = z.object({
  provider: LLMProviderSchema,
  model: z.string().min(1),
  /** Encrypted fixture holding the LLM provider API key. */
  keyFixture: z.string().min(1),
  /** Optional custom base URL (for openai-compatible endpoints like Ollama). */
  baseUrl: z.string().url().optional(),
  systemPrompt: z.string().optional(),
  userQuery: z.string().min(1),
  maxTurns: z.number().int().min(1).max(50).default(8),
  temperature: z.number().min(0).max(2).default(0.2),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// The Test Case — the authoring unit
// ---------------------------------------------------------------------------
//
// Canonical schema v2: assertions live on each step. The legacy top-level
// `expected:` block is migrated by `translateLegacy()` at parse time (see
// compat.ts). Cases authored against v2 do not carry an `expected:` field.

// A test is EITHER scripted (steps[]) OR agentic (agent). Not both.
// Automation flow redesign (Decision F): `target` is optional during the
// migration window. The case inherits its target from the parent suite's
// server_id binding; embedding the same shape in the case YAML is redundant.
// Existing case rows still carry target until tools/migrate-strip-target-block.mjs
// strips them; the runner accepts both shapes. A future tightening commit will
// make target strictly forbidden once the migration is complete.
export const ScriptedTestCaseSchema = z.object({
  kind: z.literal('scripted'),
  schemaVersion: z.literal(2).default(2),
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  clientProfile: ClientProfileSchema.default('generic'),
  target: TargetSchema.optional(),
  setup: z.array(SetupStepSchema).default([]),
  steps: z.array(ScriptedStepSchema).min(1),
});

export const AgenticTestCaseSchema = z.object({
  kind: z.literal('agentic'),
  schemaVersion: z.literal(2).default(2),
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  clientProfile: ClientProfileSchema.default('generic'),
  target: TargetSchema.optional(),
  setup: z.array(SetupStepSchema).default([]),
  agent: AgentConfigSchema,
  // Agentic cases get their assertions as a flat array (no steps to attach
  // them to). The legacy `expected:` block translates into one assertion here.
  assertions: z.array(AssertionExprSchema).default([]),
});

export const TestCaseSchema = z.discriminatedUnion('kind', [
  ScriptedTestCaseSchema,
  AgenticTestCaseSchema,
]);
export type TestCase = z.infer<typeof TestCaseSchema>;
export type ScriptedTestCase = z.infer<typeof ScriptedTestCaseSchema>;
export type AgenticTestCase = z.infer<typeof AgenticTestCaseSchema>;

// ---------------------------------------------------------------------------
// Test Suite — a collection of test cases
// ---------------------------------------------------------------------------

export const TestSuiteSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  cases: z.array(TestCaseSchema).min(1),
  /** Cron string for scheduled runs. Business tier only — enforced at API. */
  schedule: z.string().optional(),
});
export type TestSuite = z.infer<typeof TestSuiteSchema>;

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

export type TestRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'errored';

export interface AgenticTrace {
  /** Each LLM step: the model's tool calls + reasoning text + the resulting tool result. */
  turns: Array<{
    turn: number;
    llmCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
    llmText?: string;
    toolResults: Array<{ toolName: string; result: unknown; isError?: boolean }>;
  }>;
  finalText: string;
  stopReason: 'end' | 'max-turns' | 'error';
}

// T-144: a single assertion's verdict + observed/expected for the UI.
export interface AssertionResult {
  assertion: AssertionExpr;
  verdict: 'pass' | 'fail' | 'warn';
  observed?: string;
  expected?: string;
  error?: string;
}

// T-144: per-step capture surfaces in the run-detail pane.
export interface PerStepResult {
  stepIndex: number;
  kind: string;
  name: string;
  /** The arguments AFTER fixture/binding interpolation. Shows what was actually sent to the server. */
  resolvedArguments?: Record<string, unknown>;
  /** Truncated to ~32KB when persisted. */
  response: unknown;
  latencyMs: number;
  assertions: AssertionResult[];
}

export interface TestRunResult {
  testCaseId: string;
  runId: string;
  status: TestRunStatus;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  /** For agentic runs only. */
  agenticTrace?: AgenticTrace;
  /** Aggregate verdict across all per-step assertions. */
  verdict?: 'pass' | 'fail' | 'warn';
  /** Confidence score 0-1 (semantic only, single-assertion legacy carry-over). */
  confidence?: number;
  /** Joined reasoning summary (first failing assertion or "all passed"). */
  reasoning?: string;
  /** Raw evidence the judge saw (final response for scripted; trace for agentic). */
  evidence?: unknown;
  /** T-144: per-step results — captures response + assertion verdicts per step. */
  perStepResults?: PerStepResult[];
  /** Diagnostic error message when status='errored'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export function parseTestCase(input: unknown): TestCase {
  // Apply the legacy `expected:` translator before Zod validation. Migration
  // is idempotent: documents already at schemaVersion 2 pass through untouched.
  const migrated = translateLegacy(input);
  return TestCaseSchema.parse(migrated);
}

export function parseTestSuite(input: unknown): TestSuite {
  // Translate each case inside the suite before validation.
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Array.isArray((input as { cases?: unknown[] }).cases)
  ) {
    const raw = input as Record<string, unknown>;
    const cases = (raw.cases as unknown[]).map(translateLegacy);
    return TestSuiteSchema.parse({ ...raw, cases });
  }
  return TestSuiteSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Runner progress events (live streaming hook)
// ---------------------------------------------------------------------------
//
// Both runScripted and runAgentic accept an optional `onEvent` callback. The
// callback receives per-step (scripted) or per-turn (agentic) progress.
// Listener errors are swallowed inside the runner — progress emission must
// never abort the run.

export type RunnerEvent =
  | { type: 'step'; index: number; kind: string; name: string }
  | {
      type: 'agentic-turn';
      turn: number;
      toolCalls: Array<{ name: string }>;
      text?: string;
    };

export type RunnerEventListener = (event: RunnerEvent) => void;
