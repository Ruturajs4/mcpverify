// `mcpverify compliance [...]` surface router.
//
// Phase 1: run, runs list, view.
// Phase 2: matrix, runs stream <id>, runs delete <id>.

export async function route(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    printComplianceHelp();
    return;
  }

  const [head, second] = args;
  switch (head) {
    case 'run': {
      const { runHandler } = await import('./run.js');
      return runHandler(args.slice(1));
    }
    case 'matrix': {
      const { matrixHandler } = await import('./matrix.js');
      return matrixHandler(args.slice(1));
    }
    case 'runs': {
      if (!second || second === '--help' || second === '-h') {
        process.stdout.write(`USAGE
  mcpverify compliance runs list                 List your recent compliance runs
  mcpverify compliance runs stream <runId>       Tail an in-progress run via SSE
  mcpverify compliance runs delete <runId>       Delete a run + its assertion results
`);
        return;
      }
      if (second === 'list') {
        const { listHandler } = await import('./runs-list.js');
        return listHandler(args.slice(2));
      }
      if (second === 'stream') {
        const { streamHandler } = await import('./runs-stream.js');
        return streamHandler(args.slice(2));
      }
      if (second === 'delete') {
        const { deleteHandler } = await import('./runs-delete.js');
        return deleteHandler(args.slice(2));
      }
      console.error(`Unknown command: compliance runs ${second}`);
      printComplianceHelp();
      process.exit(2);
      return;
    }
    case 'view': {
      const { viewHandler } = await import('./view.js');
      return viewHandler(args.slice(1));
    }
    default:
      console.error(`Unknown command: compliance ${head}`);
      printComplianceHelp();
      process.exit(2);
  }
}

function printComplianceHelp(): void {
  process.stdout.write(`mcpverify compliance — the 89-assertion protocol probe

USAGE
  mcpverify compliance <command> [options]

COMMANDS
  run                       Capture a fresh trace from your MCP server, score it.
  runs list                 List your recent compliance runs.
  runs stream <runId>       Tail an in-progress run (SSE).
  runs delete <runId>       Delete a run + its assertion results.
  view <runId>              Show one run's full assertion breakdown.
  matrix                    Per-server pass/fail rollup over recent runs.

Run \`mcpverify compliance <command> --help\` for command-specific options.

EXAMPLES
  mcpverify compliance run --transport http --url https://your-server.com/mcp
  mcpverify compliance runs list --limit 5
  mcpverify compliance matrix
  mcpverify compliance view a1b2c3d4e5...
`);
}
