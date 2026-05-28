// Top-level help text for `mcpverify` / `mcpverify --help`.
// Each surface (compliance/automation/diagnose/servers) has its own help in
// the surface's own index.ts so the lazy-load model keeps `mcpverify --help`
// cheap.

// TODO: derive from package.json at build time. This constant drifted
// in the 0.5.0 release (banner reported 0.4.2) — caught only because a
// post-publish smoke test ran. Next refactor: a build-time generator.
export const SDK_VERSION = '0.7.1';

export function printVersion(): void {
  console.log(`@mcp-verify/sdk ${SDK_VERSION}`);
}

export function printTopLevelHelp(): void {
  process.stdout.write(`mcpverify ${SDK_VERSION} — the testing platform for MCP servers.

USAGE
  mcpverify <surface> <command> [options]
  mcpverify --version | --help

SURFACES
  compliance    The 89-assertion protocol probe (was: \`mcpverify run\`)
  automation    Assert Studio — suites, cases, fixtures, LLM-judge agents
  diagnose      5-layer connectivity probe (DNS, TLS, init, auth, tools/list)
  servers       Registered MCP server entries (CRUD + probe)
  auth          Identity probe (whoami)

EXAMPLES
  mcpverify auth whoami
  mcpverify compliance run --transport http --url https://your-server.com/mcp --bearer "$TOKEN"
  mcpverify compliance matrix
  mcpverify compliance runs stream <runId>
  mcpverify automation suite list
  mcpverify automation suite create --name "Smoke" --server-id <serverId>
  mcpverify automation fixture create secret my-token --stdin
  mcpverify automation agent create --name "GPT-4o" --provider openai --model gpt-4o --stdin
  mcpverify servers create --name "Prod" --transport http --url https://api.example.com/mcp
  mcpverify servers probe <serverId>
  mcpverify diagnose --transport http --url https://your-server.com/mcp

LEGACY (still works, deprecation warning printed)
  mcpverify run [...]            → forwards to \`mcpverify compliance run\`
  mcpverify suite run <id>       → forwards to \`mcpverify automation suite run <id>\`
  mcpverify studio run <file>    → unchanged (ship YAML to cloud for scoring)

Run \`mcpverify <surface> --help\` for surface-specific commands.
Docs: https://mcpverify.dev/docs
`);
}
