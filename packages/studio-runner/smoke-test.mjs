// Phase 0 smoke test — runs a scripted test against the demo MCP server with
// an Exact judge (no LLM needed). Verifies the studio-runner pipeline works
// end-to-end: open transport → initialize → tools/call → judge → result.
//
// Usage: node packages/studio-runner/smoke-test.mjs

import { runScripted } from './dist/index.js';

const testCase = {
  kind: 'scripted',
  name: 'demo: read_file passes for valid path',
  description: 'Smoke test for studio-runner scripted execution.',
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
      arguments: { text: 'hello mcpverify' },
    },
  ],
  expected: {
    mode: 'schema',
    schema: {
      type: 'object',
      properties: {
        content: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', required: ['type'] },
        },
      },
      required: ['content'],
    },
  },
};

const result = await runScripted({
  testCase,
  runId: 'smoke-1',
  testCaseId: 'demo-echo',
  resolveFixture: async (name) => { throw new Error(`No fixture resolver: ${name}`); },
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'passed' ? 0 : 1);
