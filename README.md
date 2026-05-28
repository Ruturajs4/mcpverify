# MCPVerify — protocol relay + test execution runtime

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm](https://img.shields.io/npm/v/@mcp-verify/sdk.svg)](https://www.npmjs.com/package/@mcp-verify/sdk)

The open-source parts of [MCPVerify](https://mcpverify.dev) — the testing platform for [Model Context Protocol](https://modelcontextprotocol.io) servers.

## What's in this repo

| Package | Status | What it does |
|---------|--------|--------------|
| [`@mcp-verify/sdk`](./packages/sdk) | Apache-2.0, published to npm | Protocol relay. Captures the JSON-RPC trace between a generic MCP client and your MCP server, ships it to mcpverify.dev for scoring, prints a report URL. Supports stdio / Streamable HTTP / SSE transports, OAuth 2.1 + PKCE + DCR, pre-acquired bearer tokens, custom headers. |
| [`@mcp-verify/studio-runner`](./packages/studio-runner) | Apache-2.0 | Assert Studio test execution runtime. Scripted runner (deterministic chains of tool calls with N path-based assertions per step), agentic runner (Vercel-AI-SDK-driven LLM loops with multi-provider BYO keys), 12-operator evaluator. |

## What's NOT here

The validation engine (the 89→200 MCP-spec assertions), the web app, the cross-server compatibility matrix, and the cloud scoring endpoint live in a separate proprietary repo. Hosted at [mcpverify.dev](https://mcpverify.dev) — sign up there to get a personalized report on your MCP server.

See [`OSS.md` in the closed repo (linked from the main site)](https://mcpverify.dev/oss) for the full split rationale.

## Quick start

### Use the SDK against a hosted MCP server

```bash
# Install the CLI globally
npm install -g @mcp-verify/sdk

# Run a probe against an HTTP MCP server, get a report URL
mcpverify compliance run \
  --transport http \
  --url https://your-mcp-server.example.com/mcp \
  --bearer "$YOUR_TOKEN" \
  --api-key "$MCPVERIFY_API_KEY"
```

The SDK ships the captured trace to `mcpverify.dev`, the cloud-side engine validates it against 89+ assertions, and you get a URL with the full breakdown.

### Use the SDK against a stdio MCP server

```bash
mcpverify compliance run --transport stdio --command "node my-server.js"
```

### Or use it without our cloud

The SDK is Apache-2.0 — fork it, run it locally, or wire it into your CI. The cloud scoring is optional; the protocol relay + trace capture + auth dance all happen client-side.

## What you can do beyond compliance

The CLI organises into four surfaces, all bearer-authed against the same MCPVerify API key:

| Surface | Example |
|---|---|
| `compliance` | `mcpverify compliance run --transport http --url …` |
| `automation` | `mcpverify automation suite list` / `… suite run <id>` / `… fixture create secret my_token --stdin` |
| `diagnose`   | `mcpverify diagnose --transport http --url …` (5-layer DNS→TLS→init→auth→tools/list probe) |
| `servers`    | `mcpverify servers list` / `… create` / `… probe <id>` |
| `auth`       | `mcpverify auth whoami` (verify your api-key) |

Run `mcpverify --help` for the full surface list, or see [`packages/sdk/README.md`](./packages/sdk/README.md) for the complete CLI + programmatic API reference. The legacy flat shapes (`mcpverify run`, `mcpverify suite run`, `mcpverify studio run`) still work with a deprecation banner.

## OAuth 2.1 + PKCE

The SDK does automatic OAuth 2.1 (RFC 6749) + PKCE (RFC 7636) + Dynamic Client Registration (RFC 7591) discovery against `.well-known/oauth-authorization-server` (RFC 8414). When an HTTP MCP server responds with 401 + valid metadata, the SDK opens a browser popup, runs the flow, caches the access token, and retries.

```bash
mcpverify compliance run --transport http --url https://oauth-gated-server.example.com/mcp
# → opens browser, you authorize, SDK continues
```

For CI / non-interactive contexts, pre-acquire the token and pass `--bearer`:

```bash
mcpverify compliance run --transport http --url … --bearer "$TOKEN" --no-interactive
```

## GitHub Actions integration

There's no published `mcpverify/action@v1` wrapper today — invoke the SDK directly via `npx`. The CLI auto-switches to JSON output on non-TTY stdout, so reports pipe cleanly through `jq` or get archived as artifacts.

```yaml
# .github/workflows/mcpverify.yml
- name: MCPVerify compliance probe
  env:
    MCPVERIFY_API_KEY: ${{ secrets.MCPVERIFY_API_KEY }}
  run: |
    npx -y @mcp-verify/sdk compliance run \
      --transport http \
      --url ${{ env.MCP_URL }} \
      --bearer "${{ secrets.MCP_TOKEN }}" \
      --no-interactive > mcpverify-report.json
- uses: actions/upload-artifact@v4
  with: { name: mcpverify-report, path: mcpverify-report.json }
```

Exit code `1` = at least one assertion failed (CI step fails). Exit code `2` = SDK itself errored. Adjust the timeouts for slow networks via `MCPVERIFY_API_TIMEOUT_MS` and `MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS`.

A sample workflow lives at [`docs/ci` on the main site](https://mcpverify.dev/docs).

## Architecture

- **SDK** is the client-side protocol relay. It speaks MCP, captures every JSON-RPC message, knows about OAuth, and ships the trace. It does NOT score the trace — that's the cloud's job.
- **Studio-runner** is the test execution runtime used by the closed Assert Studio. It runs scripted (deterministic) and agentic (LLM-driven) test cases against MCP servers, evaluates assertions, and returns per-step results. The cloud calls it directly; you can also invoke it programmatically.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). TL;DR:

1. File issues for bugs and feature requests.
2. PRs welcome against this repo, but understand that this is a **downstream mirror** of the closed monorepo. Maintainers cherry-pick PRs into the closed repo, then the next sync pushes them back here.
3. For security issues, email `security@mcpverify.dev` instead of filing a public issue.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
