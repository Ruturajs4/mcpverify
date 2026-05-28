# Contributing to `@mcp-verify/studio-runner`

The studio-runner is MCPVerify's test execution runtime: it opens MCP transports, runs scripted or agentic test cases, dispatches deterministic + semantic assertions, and reports structured results.

## Quick start

```bash
git clone https://github.com/Ruturajs4/mcpverify.git
cd mcpverify
pnpm install
pnpm -r typecheck
pnpm -r build
node packages/studio-runner/smoke-test.mjs
```

## Architecture overview

Three layers, each in its own file:

- **Schema** (`src/schema.ts`) — Zod definitions for `TestCase`, `AssertionExpr`, fixture sources, agent config. The contract between authoring (YAML/UI), persistence (DB), and execution.
- **Runners** (`src/scripted-runner.ts`, `src/agentic-runner.ts`) — execute test cases against an MCP server. The agentic runner uses Vercel AI SDK with a BYO-key model.
- **Evaluator** (`src/evaluator.ts`) — dispatches the 12 assertion operators (exists, equals, contains, length, oneOf, jsonpath, regex, schema, latency, semantic, notExists, notEquals).

Multi-provider LLM support is via `src/model-resolver.ts` (Anthropic, OpenAI, Google, OpenAI-compatible endpoints).

## Commit messages

Conventional commits — `feat(studio-runner): add length assertion operator`, `fix(studio-runner): handle JSONPath result with null root`, etc.

## Tests

- `smoke-test.mjs` — scripted run vs the demo MCP server. Must pass on every PR.
- `smoke-deterministic.mjs` — exercises the new N-assertions-per-step path.
- Provider-specific runtime tests are gated behind env vars (`ANTHROPIC_API_KEY`, etc.) and run optionally.

## Code style

- TypeScript strict mode. Discriminated unions over open shapes wherever possible.
- Side-effect-free helpers in `src/` files; impure runner orchestrators clearly named.
- Format with the repo's Prettier config.

## Reporting bugs

GitHub issue with: studio-runner version, the test-case YAML (redact fixture references), the target MCP server transport, and any stack trace. If the bug involves an LLM provider, name the provider + model.

## Security

Email `security@mcpverify.dev` for vulnerabilities (especially SSRF in dynamic fixtures, secret leaks in agentic traces, or LLM prompt injection cases).

## License

Contributions are licensed under the Apache License 2.0, same as the package itself.
