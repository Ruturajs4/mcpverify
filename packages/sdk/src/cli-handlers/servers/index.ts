// `mcpverify servers [...]` surface router.

export async function route(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    printServersHelp();
    return;
  }
  const head = args[0];
  switch (head) {
    case 'list': {
      const { listHandler } = await import('./list.js');
      return listHandler(args.slice(1));
    }
    case 'create': {
      const { createHandler } = await import('./create.js');
      return createHandler(args.slice(1));
    }
    case 'delete': {
      const { deleteHandler } = await import('./delete.js');
      return deleteHandler(args.slice(1));
    }
    case 'update': {
      const { updateHandler } = await import('./update.js');
      return updateHandler(args.slice(1));
    }
    case 'probe': {
      const { probeHandler } = await import('./probe.js');
      return probeHandler(args.slice(1));
    }
    default:
      console.error(`Unknown command: servers ${head}`);
      printServersHelp();
      process.exit(2);
  }
}

function printServersHelp(): void {
  process.stdout.write(`mcpverify servers — registered MCP server entries

USAGE
  mcpverify servers <command> [options]

COMMANDS
  list                       List your registered MCP servers
  create                     Register a new server (--name --transport --url|--command)
  update <serverId>          Update one or more fields on an existing server
  probe <serverId>           Re-probe auth state + tool discovery
  delete <serverId> --yes    Remove a registered server

Run \`mcpverify servers <command> --help\` for command-specific options.
`);
}
