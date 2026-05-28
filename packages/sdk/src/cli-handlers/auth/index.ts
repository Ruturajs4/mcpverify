// `mcpverify auth [...]` surface router.
//
// Phase 2 commands: `whoami`. Token-based login flows are deferred
// (api-key + env-var pattern is the only auth surface for now).

export async function route(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    printAuthHelp();
    return;
  }
  const head = args[0];
  switch (head) {
    case 'whoami': {
      const { whoamiHandler } = await import('./whoami.js');
      return whoamiHandler(args.slice(1));
    }
    default:
      console.error(`Unknown command: auth ${head}`);
      printAuthHelp();
      process.exit(2);
  }
}

function printAuthHelp(): void {
  process.stdout.write(`mcpverify auth — identity + api-key validation

USAGE
  mcpverify auth <command> [options]

COMMANDS
  whoami         Verify your api-key and print the authenticated user

EXAMPLES
  mcpverify auth whoami
  mcpverify auth whoami --api-key mcpv_live_xxxx
`);
}
