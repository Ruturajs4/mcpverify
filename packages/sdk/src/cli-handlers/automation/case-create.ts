// `mcpverify automation case create --suite <id> --yaml <file> --name <n> --kind scripted|agentic`
//
// Reads the YAML body from a file path (so the value never has to go through argv).
// The cloud re-validates against the runner's TestCaseSchema before persisting.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

export async function caseCreateHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:        { type: 'boolean', short: 'h' },
      'api-key':   { type: 'string' },
      'api-url':   { type: 'string' },
      suite:       { type: 'string' },
      name:        { type: 'string' },
      description: { type: 'string' },
      kind:        { type: 'string' },
      yaml:        { type: 'string' },
      stdin:       { type: 'boolean' },
      json:        { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify automation case create — create a test case from a YAML file

USAGE
  mcpverify automation case create --suite <id> --name <n> --kind <k> --yaml <file>
  cat case.yaml | mcpverify automation case create --suite <id> --name <n> --kind <k> --stdin

REQUIRED
  --suite <id>        Suite id to create the case in
  --name <n>          Case name (1-120 chars)
  --kind <k>          'scripted' or 'agentic'
  --yaml <file>       Path to a YAML file (or use --stdin to pipe)

OPTIONAL
  --description <s>   Free-form note (max 2000 chars)

The YAML must conform to the studio-runner TestCaseSchema. See
the docs at https://app.mcpverify.dev/docs/test-yaml for the shape.
`);
    return;
  }

  const suite = values.suite as string | undefined;
  const name = values.name as string | undefined;
  const kind = values.kind as string | undefined;
  if (!suite || !name || !kind) {
    console.error('Error: --suite, --name, and --kind are required');
    process.exit(2);
  }
  if (!['scripted', 'agentic'].includes(kind)) {
    console.error("Error: --kind must be 'scripted' or 'agentic'");
    process.exit(2);
  }

  let yaml: string;
  if (values.stdin) {
    yaml = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  } else if (values.yaml) {
    try {
      yaml = await readFile(values.yaml as string, 'utf8');
    } catch (err) {
      console.error(`Error reading ${values.yaml}: ${(err as Error).message}`);
      process.exit(2);
    }
  } else {
    console.error('Error: pass --yaml <file> or --stdin');
    process.exit(2);
  }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  try {
    const created = await client.automation.cases.create({
      suiteId: suite,
      name,
      kind: kind as 'scripted' | 'agentic',
      yaml,
      ...(values.description ? { description: values.description as string } : {}),
    });
    if (values.json) { emitJson(created); return; }
    process.stdout.write(`Created case "${created.name}" (id ${created.id})\n`);
    process.stdout.write(`Run it: mcpverify automation case run ${created.id}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: suite ${suite} not found`); process.exit(3); }
    if (e.status === 400) {
      console.error(`Error: ${e.message}`);
      console.error('Hint: the YAML must validate against the runner schema. See https://app.mcpverify.dev/docs/test-yaml');
      process.exit(2);
    }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
