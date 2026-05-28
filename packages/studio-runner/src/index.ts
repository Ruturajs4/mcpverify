// @mcp-verify/studio-runner — public OSS entry point.
//
// CHANGED IN 0.1.0 (2026-05-28, T-184):
//
//   The following exports were REMOVED in this version. They moved to the
//   proprietary @mcp-verify/studio-runtime package (NOT on npm; consumed only
//   by the mcpverify.dev cloud). To execute a suite end-to-end, use the
//   `mcpverify automation suite run-local <id>` CLI command in
//   @mcp-verify/sdk@^0.7.0 — it executes steps locally and POSTs each step's
//   captured response to the cloud's /evaluate endpoint for scoring.
//
//   REMOVED — use the sdk@0.7.0 CLI + cloud /evaluate instead:
//     runScripted, runAgentic, evaluateAssertions, aggregateVerdict,
//     summarizeReasoning, type EvalContext, generateTestCase,
//     type GenerateOptions, type GenerateResult
//
// STILL EXPORTED (building blocks, OSS-safe):

export * from './schema.js';
export { translateLegacy } from './compat.js';
export { evalJsonpath, evalJsonpathOne, normalizePath } from './jsonpath.js';
export {
  executeDynamicHttpSource,
  executeTeardown,
  type SafeFetchFn,
  type ResolveFixtureFn,
} from './dynamic-fixture.js';
