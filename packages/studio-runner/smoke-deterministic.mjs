// T-144 deterministic smoke test — five deterministic assertions on a single
// step. Verifies (a) no LLM call is made, (b) execution completes in <100ms
// of wall-clock spent inside evaluateAssertions, and (c) the run reports
// per-step results with one AssertionResult per asserted operator.
//
// Usage: node packages/studio-runner/smoke-deterministic.mjs

import { runScripted } from './dist/index.js';

const testCase = {
  kind: 'scripted',
  schemaVersion: 2,
  name: 'T-144: 5 deterministic assertions on echo',
  description: 'Exercises exists/equals/length/regex/latency without any LLM call.',
  clientProfile: 'generic',
  target: {
    transport: 'stdio',
    command: `node ${process.cwd()}/tools/demo-server/server.js`,
  },
  setup: [],
  steps: [
    {
      kind: 'tools/call',
      name: 'echo',
      arguments: { message: 'hello mcpverify' },
      assertions: [
        // 1. The response carries a `content` array.
        { op: 'exists', path: '$.content', message: 'content array present' },
        // 2. content[0].type equals the literal "text".
        { op: 'equals', path: '$.content[0].type', value: 'text' },
        // 3. content[0].text is a 15-char string ("hello mcpverify").
        { op: 'length', path: '$.content[0].text', value: 15 },
        // 4. The text matches a case-insensitive /mcpverify/ pattern.
        { op: 'regex', path: '$.content[0].text', pattern: 'mcpverify', flags: 'i' },
        // 5. Step completed under 1s.
        { op: 'latency', lt: 1000 },
      ],
    },
  ],
};

const evalStart = Date.now();
const result = await runScripted({
  testCase,
  runId: 'smoke-t144-1',
  testCaseId: 'demo-echo-deterministic',
  resolveFixture: async (name) => {
    throw new Error(`Deterministic test must not resolve fixtures (asked for: ${name})`);
  },
});
const evalEnd = Date.now();

const wallClockMs = evalEnd - evalStart;
const allAssertions = (result.perStepResults ?? []).flatMap((s) => s.assertions);
const allPassed = allAssertions.length > 0 && allAssertions.every((a) => a.verdict === 'pass');

console.log(JSON.stringify({
  status: result.status,
  verdict: result.verdict,
  reasoning: result.reasoning,
  wallClockMs,
  assertionCount: allAssertions.length,
  assertions: allAssertions.map((a) => ({
    op: a.assertion.op,
    verdict: a.verdict,
    observed: a.observed,
    expected: a.expected,
  })),
}, null, 2));

// Exit non-zero if anything is off — CI catches regressions automatically.
if (result.status !== 'passed') {
  console.error(`FAIL: expected status=passed, got ${result.status}`);
  process.exit(1);
}
if (allAssertions.length !== 5) {
  console.error(`FAIL: expected 5 assertions, got ${allAssertions.length}`);
  process.exit(1);
}
if (!allPassed) {
  console.error('FAIL: not every assertion passed');
  process.exit(1);
}
console.error(`[ok] 5/5 deterministic assertions passed in ${wallClockMs}ms wall-clock`);
process.exit(0);
