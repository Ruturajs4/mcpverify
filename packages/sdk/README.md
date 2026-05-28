# @mcp-verify/sdk

> The testing platform for MCP servers. Find spec violations, security issues, auth gaps, and compatibility bugs in your Model Context Protocol server in seconds.

[![npm](https://img.shields.io/npm/v/@mcp-verify/sdk.svg)](https://www.npmjs.com/package/@mcp-verify/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

```bash
# Local stdio server
npx -y @mcp-verify/sdk compliance run --transport stdio --command "node dist/server.js"

# Remote HTTP server (auto OAuth if gated)
npx -y @mcp-verify/sdk compliance run --transport http --url https://mcp.example.com/mcp

# Identity probe — quickest way to verify your api-key works
npx -y @mcp-verify/sdk auth whoami
```

## What's new in 0.4.x

- **Subcommand tree.** `mcpverify <surface> <command>` — surfaces are `compliance`, `automation`, `diagnose`, `servers`, `auth`. The legacy flat `mcpverify run`, `mcpverify suite run`, `mcpverify studio run` shapes still work with a deprecation banner.
- **Assert Studio CLI parity.** Full CRUD for suites, cases, fixtures, and LLM-as-judge agents from the command line. The CLI is now a complete replacement for the web app's authoring surface.
- **`McpVerifyClient` class.** Typed programmatic API with namespaced methods (`client.compliance.run()`, `client.automation.fixtures.list()`, etc.) — same auth as the CLI.
- **Fetch timeouts everywhere.** 30s default on every API call (60s on trace upload), overridable via `MCPVERIFY_API_TIMEOUT_MS` and `MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS`. Previously the CLI would hang forever on a slow server.
- **`compliance matrix`** — per-server pass/fail rollup across recent runs. Surfaces truncation explicitly when you have >100 runs.
- **Secrets stay out of argv.** `fixture create secret`, `agent create`, `servers create --auth-kind bearer` all accept `--stdin` so values never appear in shell history.

## The four surfaces

| Surface | What it does |
|---|---|
| `compliance` | The 89-assertion protocol probe. Captures a JSON-RPC trace from your server and scores it. |
| `automation` | Assert Studio. Custom test suites, cases, fixtures, LLM-as-judge agents. |
| `diagnose` | 5-layer connectivity probe (DNS, TLS, initialize, auth, tools/list). |
| `servers` | Registered MCP server entries with stored auth and a stable id. |
| `auth` | Identity probe (`whoami`). |

Run `mcpverify --help` for the full surface list; `mcpverify <surface> --help` drills in.

## How it works

1. **Your server runs locally (stdio) or remotely (http/sse).** The SDK connects.
2. **The SDK captures the JSON-RPC trace** — every initialize, tools/list, tools/call, prompts/list, resources/list, plus auth probes for HTTP/SSE.
3. **The trace is shipped to mcpverify.dev** for cloud-side scoring against the validation engine (89 assertions across 8 surfaces, growing to 200).
4. **You get a report URL** with pass/fail, observed vs expected, evidence, and a remediation hint per failure.

We don't see your code — only the JSON-RPC messages your server emits and the OAuth metadata it publishes.

## Installation

```bash
# One-shot via npx
npx -y @mcp-verify/sdk compliance run --transport stdio --command "node dist/server.js"

# Or save as a dev dependency
npm install --save-dev @mcp-verify/sdk
```

## Authentication (MCPVerify, not your server)

MCPVerify is invite-only during private beta. Once invited:

1. Visit `https://app.mcpverify.dev/settings/api-keys`
2. Create a key (`mcpv_live_...`)
3. Pass via flag or env var:

```bash
export MCPVERIFY_API_KEY=mcpv_live_...
# or
mcpverify compliance run --api-key mcpv_live_... ...
```

Then verify it works:

```bash
mcpverify auth whoami
# Authenticated as you@example.com (Your Name)
# User id:   ...
# Auth via:  api-key
```

## Compliance probe

### Transports

```bash
# stdio (default)
mcpverify compliance run --transport stdio --command "node dist/server.js"

# Streamable HTTP (2025-03-26 spec)
mcpverify compliance run --transport http --url https://my-mcp.example.com/mcp

# SSE (2024-11-05 spec)
mcpverify compliance run --transport sse  --url https://my-mcp.example.com/sse
```

For HTTP and SSE, the SDK runs a separate **auth probe** before the JSON-RPC probe: unauthenticated POST → `WWW-Authenticate` capture → `GET /.well-known/oauth-authorization-server` (RFC 8414) → reachability of default `/authorize`, `/token`, `/register` endpoints. The probe feeds the AUTH-001..AUTH-004 assertions plus the `auth_state` classifier.

### Auth modes for your server

The MCP authorization spec mandates OAuth 2.1. The SDK supports three modes:

```bash
# --auth none — skip auth entirely, probe the open surface
mcpverify compliance run -t http -u https://open-mcp.example.com/mcp --auth none

# --bearer <token> — pre-acquired token, CI-friendly
mcpverify compliance run -t http -u https://mcp.linear.app/v1/mcp \
  --bearer "$LINEAR_TOKEN"

# --auth oauth — interactive PKCE flow, browser-based
mcpverify compliance run -t http -u https://mcp.linear.app/v1/mcp \
  --auth oauth --scope read --scope write
```

If you pass neither `--bearer` nor `--auth` and the server returns 401 + has usable RFC 8414 metadata + you're on a TTY, the SDK initiates the OAuth flow automatically. Override with `--no-interactive` (or pipe stdout) to disable for CI.

### List, view, matrix, stream

```bash
mcpverify compliance runs list --limit 10
mcpverify compliance view <runId>
mcpverify compliance matrix
mcpverify compliance runs stream <runId>     # SSE tail of an in-progress run
mcpverify compliance runs delete <runId> --yes
```

### Custom headers

```bash
mcpverify compliance run -t http -u https://api.example.com/mcp \
  --bearer "$TOKEN" \
  -H "X-Tenant-Id: acme" \
  -H "X-Workspace: prod"
```

`Authorization` is reserved for `--bearer`/`--auth`; conflicting `-H "Authorization: ..."` values are ignored with a warning.

## Automation (Assert Studio)

### Suites + cases

```bash
mcpverify automation suite list
mcpverify automation suite create --name "Smoke" --server-id <serverId>
mcpverify automation suite run <suiteId>                # fetches + runs LOCALLY
mcpverify automation suite delete <suiteId> --yes

mcpverify automation case run <caseId>                  # single-case, server-side
mcpverify automation case create --suite <id> --name N --kind scripted --yaml file.yaml
mcpverify automation case delete <caseId> --yes
```

`suite run` executes locally because stdio servers can't be reached from the cloud. `case run` dispatches a single case server-side — faster, only works for cases whose target is HTTP/SSE.

### Fixtures (Postman-style `{{vars}}`)

```bash
# Variable: plaintext value
mcpverify automation fixture create variable my_var --value "hello"

# Secret: AES-256-GCM encrypted at rest. Use --stdin so the value
# never appears in argv / shell history.
echo "$YOUR_SECRET" | mcpverify automation fixture create secret my_token --stdin

# Dynamic-HTTP: refreshes itself on a schedule
mcpverify automation fixture create dynamic-http my_oauth \
  --url https://auth.example.com/token \
  --extract '$.access_token' \
  --ttl 3600

mcpverify automation fixture list
mcpverify automation fixture delete my_token --yes
```

Reference a fixture inside a case YAML with `{{my_token}}`. The runner interpolates at dispatch time, after lookup against the user's encrypted fixture store.

### LLM-as-judge agents

```bash
# Register a provider credential. api_key is encrypted at rest.
echo "$OPENAI_API_KEY" | mcpverify automation agent create \
  --name "GPT-4o judge" --provider openai --model gpt-4o --stdin

mcpverify automation agent list
mcpverify automation agent delete <agentId> --yes
```

Reference an agent by id in a case's `kind: agentic` step. The runner decrypts the api_key at run time and passes it to the provider — the SDK never sees it.

## Servers

```bash
mcpverify servers list

# Register
mcpverify servers create \
  --name "Prod MCP" \
  --transport http \
  --url https://api.example.com/mcp \
  --auth-kind bearer --bearer-stdin

# Re-probe (refresh auth state + tool discovery)
mcpverify servers probe <serverId>

# Update (PATCH; only set fields are sent)
mcpverify servers update <serverId> -H "X-Tenant: acme"

# Delete (cascades suites to detached)
mcpverify servers delete <serverId> --yes
```

Servers are first-class entities — assertion verdicts roll up against the server id, so renaming the URL doesn't break the historical compatibility matrix.

## Diagnose

```bash
mcpverify diagnose --transport http --url https://mcp.example.com/mcp
```

5-layer probe: DNS-TCP → TLS → initialize → auth → tools/list. Prints a colorized table indicating which layer failed. Useful before a long compliance probe to confirm the server is reachable + responsive at all.

## Programmatic API

Every surface has typed methods under `McpVerifyClient`:

```typescript
import { McpVerifyClient } from '@mcp-verify/sdk';

const client = new McpVerifyClient({
  apiKey: process.env.MCPVERIFY_API_KEY!,
  // apiUrl defaults to https://api.mcpverify.dev
});

// Compliance
const run = await client.compliance.run({
  transport: 'http',
  url: 'https://your-server.example.com/mcp',
});
console.log(`${run.summary.passed}/${run.summary.total} passed — ${run.reportUrl}`);

const recent = await client.compliance.listRuns({ limit: 10 });
const matrix = await client.compliance.matrix();

// Automation
const suites = await client.automation.listSuites();
const suiteResult = await client.automation.runSuite(suites[0].id);
const caseResult  = await client.automation.runCase(caseId);

await client.automation.fixtures.createSecret('my_token', process.env.SECRET!);
await client.automation.agents.create({
  name: 'GPT-4o', provider: 'openai', model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
});

// Servers
const servers = await client.servers.list();
const probe   = await client.servers.probe(servers[0].id);

// Diagnose
const layers = await client.diagnose.run({
  transport: 'http', url: 'https://mcp.example.com/mcp',
});

// Identity
const me = await client.auth.whoami();
```

The module-level `run()`, `runSuiteLocal()`, `runDiagnose()` exports from earlier versions stay exported — `McpVerifyClient` is purely additive ergonomics.

## CI / GitHub Actions

There's no published `mcpverify/action@v1` wrapper today — invoke the SDK directly via `npx`:

```yaml
# .github/workflows/mcp.yml
- name: MCPVerify compliance check
  env:
    MCPVERIFY_API_KEY: ${{ secrets.MCPVERIFY_API_KEY }}
  run: |
    npx -y @mcp-verify/sdk compliance run \
      --transport http \
      --url https://staging.mcp.example.com/mcp \
      --bearer "${{ secrets.MCP_SERVER_TOKEN }}"

- name: Run a cloud-stored suite
  env:
    MCPVERIFY_API_KEY: ${{ secrets.MCPVERIFY_API_KEY }}
  run: npx -y @mcp-verify/sdk automation suite run ${{ vars.SUITE_ID }}

- name: Gate a deploy on the matrix verdict
  env:
    MCPVERIFY_API_KEY: ${{ secrets.MCPVERIFY_API_KEY }}
  run: |
    npx -y @mcp-verify/sdk compliance matrix --json | \
      jq -e '.cells | all(.last_verdict == "pass")'
```

Exit code `1` = at least one assertion failed (CI step fails). Exit code `2` = SDK itself errored (network, missing args, auth). The CLI auto-switches to JSON on non-TTY stdout, so piping through `jq` works without `--json` — though `--json` makes intent explicit.

For slow CI networks set the timeouts higher:

```yaml
env:
  MCPVERIFY_API_TIMEOUT_MS: 60000          # default 30000
  MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS: 180000 # default 60000
```

## What gets tested

89 assertions across 8 surfaces (Phase 1 critical set; growing to 200):

| Surface       | Examples |
|---------------|----------|
| `protocol`    | JSON-RPC 2.0 envelope, version negotiation, initialize lifecycle |
| `tools`       | inputSchema validity, content shapes, isError vs JSON-RPC errors, name uniqueness |
| `prompts`     | prompts/list shape, arguments validation |
| `resources`   | URI scheme, listResources / readResource, templates |
| `security`    | path traversal, injection, oversized payloads, credential leakage, no Authorization echo |
| `reliability` | tool-call latency p95, concurrent requests, no JSON-RPC on stderr, resource-leak |
| `ecosystem`   | unknown-param tolerance, version negotiation graceful, capability declarations |
| `auth`        | 401 + `WWW-Authenticate: Bearer`, RFC 8414 metadata + PKCE S256, DCR reachability |

## CLI reference

```
mcpverify <surface> <command> [options]
mcpverify --version | --help

SURFACES
  compliance   The 89-assertion protocol probe
  automation   Assert Studio — suites, cases, fixtures, LLM-judge agents
  diagnose     5-layer connectivity probe
  servers      Registered MCP server entries (CRUD + probe)
  auth         Identity probe (whoami)

COMMON FLAGS
  -t, --transport <kind>   stdio | http | sse
  -u, --url <url>          Endpoint URL (http / sse)
      --command <cmd>      Server launch command (stdio)
      --api-key <key>      MCPVerify API key (or MCPVERIFY_API_KEY env)
      --api-url <url>      Override MCPVerify cloud endpoint
      --bearer <token>     Pre-acquired token for your server (CI)
      --auth-fixture <n>   Reference a stored fixture as auth (diagnose)
  -H, --header "K: V"      Extra HTTP header (repeatable)
      --json | --pretty    Force output format (default: auto by TTY)
  -h, --help               Per-command help

ENV VARS
  MCPVERIFY_API_KEY                     api-key for the MCPVerify cloud
  MCPVERIFY_API_URL                     override the default api endpoint
  MCPVERIFY_API_TIMEOUT_MS              fetch timeout, default 30000
  MCPVERIFY_TRACE_UPLOAD_TIMEOUT_MS     submitTrace timeout, default 60000

LEGACY ALIASES (still work, deprecation banner)
  mcpverify run [...]            → compliance run [...]
  mcpverify suite run <id>       → automation suite run <id>
  mcpverify studio run <file>    → unchanged (ship YAML to cloud, legacy)
```

## Why is this a thin client?

The 89 assertions and the cross-client compatibility matrix live on mcpverify.dev — not in this package. That keeps the validation logic up-to-date (push new checks server-side, every SDK install benefits) and lets us aggregate matrix data across all servers tested.

If you need fully air-gapped on-prem testing, the [Enterprise tier](https://mcpverify.dev/pricing) ships the validation engine as a self-hosted runner.

## License

Apache-2.0 for the SDK. The validation engine is proprietary.
