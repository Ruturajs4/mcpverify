#!/usr/bin/env node
// mcpverify CLI — subcommand-tree dispatcher.
//
// Surfaces:
//   mcpverify compliance run|runs|view ...    The 89-assertion protocol probe
//   mcpverify automation suite list|run ...   Assert Studio custom suites
//   mcpverify automation case run ...         Single-case dispatch
//   mcpverify diagnose ...                    5-layer connectivity probe
//   mcpverify servers list                    Registered MCP server entries
//
// Legacy aliases (deprecation warning printed, behavior preserved):
//   mcpverify run [...]            → forwards to `compliance run`
//   mcpverify suite run <id>       → forwards to `automation suite run <id>`
//   mcpverify studio run <file>    → unchanged (legacy ship-to-cloud path)
//
// Architecture (D1 in the plan):
//   - The ONLY static import is `node:util` (for parseArgs).
//   - Every surface handler is dynamic-imported on demand. `mcpverify --version`
//     loads zero SDK modules; `mcpverify --help` loads only the help printer.
//   - This keeps `mcpverify --version` <100ms even on cold disk.

const SDK_VERSION = '0.7.0';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Fast paths — never load SDK modules.
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    const { printTopLevelHelp } = await import('./cli-handlers/shared/help.js');
    printTopLevelHelp();
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`@mcp-verify/sdk ${SDK_VERSION}`);
    return;
  }

  // Legacy alias: `mcpverify run [...]` → `mcpverify compliance run [...]`
  if (args[0] === 'run') {
    const { printDeprecationWarning } = await import('./cli-handlers/shared/deprecation.js');
    printDeprecationWarning(`use 'mcpverify compliance run' instead`);
    const { runHandler } = await import('./cli-handlers/compliance/run.js');
    return runHandler(args.slice(1));
  }

  // Legacy alias: `mcpverify suite run <id> [...]` → `mcpverify automation suite run <id>`
  if (args[0] === 'suite') {
    const { printDeprecationWarning } = await import('./cli-handlers/shared/deprecation.js');
    printDeprecationWarning(`use 'mcpverify automation suite ...' instead`);
    const { route } = await import('./cli-handlers/automation/index.js');
    return route(args);  // pass through; automation/index.ts handles `suite` head
  }

  // Legacy alias: `mcpverify studio run <file>` (kept unchanged per D4)
  if (args[0] === 'studio') {
    const { run } = await import('./cli-handlers/studio.js');
    return run(args.slice(1));  // pass `run <file>` to handler
  }

  // Surface dispatch.
  switch (args[0]) {
    case 'compliance': {
      const { route } = await import('./cli-handlers/compliance/index.js');
      return route(args.slice(1));
    }
    case 'automation': {
      const { route } = await import('./cli-handlers/automation/index.js');
      return route(args.slice(1));
    }
    case 'diagnose': {
      const { run } = await import('./cli-handlers/diagnose.js');
      return run(args.slice(1));
    }
    case 'servers': {
      const { route } = await import('./cli-handlers/servers/index.js');
      return route(args.slice(1));
    }
    case 'auth': {
      const { route } = await import('./cli-handlers/auth/index.js');
      return route(args.slice(1));
    }
    default: {
      console.error(`Unknown surface: ${args[0]}\n`);
      const { printTopLevelHelp } = await import('./cli-handlers/shared/help.js');
      printTopLevelHelp();
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message ?? String(err)}`);
  process.exit(1);
});
