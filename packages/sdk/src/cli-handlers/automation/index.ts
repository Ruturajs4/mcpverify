// `mcpverify automation [...]` surface router.
//
// Phase 1: suite list, suite run, case run.
// Phase 2: suite create/delete, case create/delete, fixture CRUD, agent CRUD.

export async function route(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    printAutomationHelp();
    return;
  }
  const [head, second] = args;
  switch (head) {
    case 'suite': {
      if (!second || second === '--help' || second === '-h') {
        process.stdout.write(`USAGE
  mcpverify automation suite list                          List your suites
  mcpverify automation suite create --name N --server-id S
  mcpverify automation suite run <suiteId>                 Run a cloud-stored suite locally
  mcpverify automation suite run-local <suiteId> --local-config <file>
                                                           Run against a LOCAL stdio MCP using a config file
  mcpverify automation suite delete <suiteId> --yes        Delete a suite (cascades cases)
`);
        return;
      }
      if (second === 'list') {
        const { listHandler } = await import('./suite-list.js');
        return listHandler(args.slice(2));
      }
      if (second === 'create') {
        const { suiteCreateHandler } = await import('./suite-create.js');
        return suiteCreateHandler(args.slice(2));
      }
      if (second === 'run') {
        const { runHandler } = await import('./suite-run.js');
        return runHandler(args.slice(2));
      }
      if (second === 'run-local') {
        const { runLocalHandler } = await import('./suite-run-local.js');
        return runLocalHandler(args.slice(2));
      }
      if (second === 'delete') {
        const { suiteDeleteHandler } = await import('./suite-delete.js');
        return suiteDeleteHandler(args.slice(2));
      }
      console.error(`Unknown command: automation suite ${second}`);
      process.exit(2);
      return;
    }
    case 'case': {
      if (!second || second === '--help' || second === '-h') {
        process.stdout.write(`USAGE
  mcpverify automation case create --suite S --name N --kind K --yaml file.yaml
  mcpverify automation case run <caseId>                   Dispatch a single test case
  mcpverify automation case delete <caseId> --yes
`);
        return;
      }
      if (second === 'run') {
        const { caseRunHandler } = await import('./case-run.js');
        return caseRunHandler(args.slice(2));
      }
      if (second === 'create') {
        const { caseCreateHandler } = await import('./case-create.js');
        return caseCreateHandler(args.slice(2));
      }
      if (second === 'delete') {
        const { caseDeleteHandler } = await import('./case-delete.js');
        return caseDeleteHandler(args.slice(2));
      }
      console.error(`Unknown command: automation case ${second}`);
      process.exit(2);
      return;
    }
    case 'fixture': {
      if (!second || second === '--help' || second === '-h') {
        process.stdout.write(`USAGE
  mcpverify automation fixture list
  mcpverify automation fixture create variable <name> --value V
  mcpverify automation fixture create secret   <name> --stdin
  mcpverify automation fixture create dynamic-http <name> --url U --extract J --ttl S
  mcpverify automation fixture delete <name> --yes
`);
        return;
      }
      if (second === 'list') {
        const { fixtureListHandler } = await import('./fixture-list.js');
        return fixtureListHandler(args.slice(2));
      }
      if (second === 'create') {
        const { fixtureCreateHandler } = await import('./fixture-create.js');
        return fixtureCreateHandler(args.slice(2));
      }
      if (second === 'delete') {
        const { fixtureDeleteHandler } = await import('./fixture-delete.js');
        return fixtureDeleteHandler(args.slice(2));
      }
      console.error(`Unknown command: automation fixture ${second}`);
      process.exit(2);
      return;
    }
    case 'agent': {
      if (!second || second === '--help' || second === '-h') {
        process.stdout.write(`USAGE
  mcpverify automation agent list                          List LLM-as-judge agents
  mcpverify automation agent create --name N --provider P --model M --stdin
  mcpverify automation agent delete <agentId> --yes
`);
        return;
      }
      if (second === 'list') {
        const { agentListHandler } = await import('./agent-list.js');
        return agentListHandler(args.slice(2));
      }
      if (second === 'create') {
        const { agentCreateHandler } = await import('./agent-create.js');
        return agentCreateHandler(args.slice(2));
      }
      if (second === 'delete') {
        const { agentDeleteHandler } = await import('./agent-delete.js');
        return agentDeleteHandler(args.slice(2));
      }
      console.error(`Unknown command: automation agent ${second}`);
      process.exit(2);
      return;
    }
    default:
      console.error(`Unknown command: automation ${head}`);
      printAutomationHelp();
      process.exit(2);
  }
}

function printAutomationHelp(): void {
  process.stdout.write(`mcpverify automation — Assert Studio custom test suites, cases, fixtures, and LLM judges

USAGE
  mcpverify automation <surface> <command> [options]

SURFACES
  suite       Test suites (CRUD + run)
  case        Test cases (CRUD + single-case dispatch)
  fixture     Fixtures: variable / secret / dynamic-http (Postman-style {{vars}})
  agent       LLM-as-judge credentials (provider + model + api_key)

COMMON COMMANDS
  automation suite list
  automation suite create --name N --server-id S
  automation suite run <suiteId>
  automation case create --suite S --name N --kind scripted --yaml file.yaml
  automation case run <caseId>
  automation fixture list
  automation fixture create secret my-token --stdin
  automation agent list
  automation agent create --name "GPT-4o" --provider openai --model gpt-4o --stdin

Run \`mcpverify automation <surface> --help\` for surface-level details.
`);
}
