// `mcpverify automation agent create --name X --provider openai --model gpt-4o --stdin`
//
// api_key is read from stdin (preferred) or --api-key-value to keep it out of argv.
// (--api-key is reserved for MCPVerify auth, so we use --api-key-value for the agent's own key.)

import { parseArgs } from 'node:util';
import { McpVerifyClient } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

const VALID_PROVIDERS = [
  'anthropic', 'openai', 'google', 'mistral', 'bedrock', 'vertex', 'azure-openai', 'openai-compatible',
] as const;

type Provider = typeof VALID_PROVIDERS[number];

export async function agentCreateHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:           { type: 'boolean', short: 'h' },
      'api-key':      { type: 'string' },
      'api-url':      { type: 'string' },
      name:           { type: 'string' },
      description:    { type: 'string' },
      provider:       { type: 'string' },
      model:          { type: 'string' },
      'base-url':     { type: 'string' },
      'api-key-value': { type: 'string' },
      stdin:          { type: 'boolean' },
      json:           { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify automation agent create — register an LLM-as-judge credential

USAGE
  mcpverify automation agent create --name <n> --provider <p> --model <m> --stdin
  mcpverify automation agent create --name <n> --provider <p> --model <m> --api-key-value <k>

REQUIRED
  --name <n>          Display name (1-128 chars)
  --provider <p>      One of: ${VALID_PROVIDERS.join(', ')}
  --model <m>         Model identifier (e.g. gpt-4o, claude-opus-4-5)
  (api_key)           Provide via --stdin (preferred) or --api-key-value <k>

OPTIONAL
  --description <s>   Free-form note (max 2000 chars)
  --base-url <url>    Required for provider=openai-compatible (Ollama, Together, etc.)

EXAMPLE
  echo "$OPENAI_API_KEY" | mcpverify automation agent create \\
    --name "GPT-4o judge" --provider openai --model gpt-4o --stdin
`);
    return;
  }

  const name = values.name as string | undefined;
  const provider = values.provider as string | undefined;
  const model = values.model as string | undefined;
  if (!name || !provider || !model) {
    console.error('Error: --name, --provider, and --model are required');
    process.exit(2);
  }
  if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    console.error(`Error: --provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
    process.exit(2);
  }
  const apiKeyValue = values.stdin
    ? await readStdinValue()
    : (values['api-key-value'] as string | undefined);
  if (!apiKeyValue) {
    console.error('Error: agent api_key is required. Pass via --stdin (preferred) or --api-key-value <k>');
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
    const created = await client.automation.agents.create({
      name,
      provider: provider as Provider,
      model,
      apiKey: apiKeyValue,
      ...(values.description ? { description: values.description as string } : {}),
      ...(values['base-url'] ? { baseUrl: values['base-url'] as string } : {}),
    });
    if (values.json) { emitJson(created); return; }
    process.stdout.write(`Created agent "${created.name}" (id ${created.id})\n`);
    process.stdout.write(`Provider: ${created.provider} / model: ${created.model}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 409) { console.error(`Error: agent name "${name}" already taken`); process.exit(3); }
    if (e.status === 400) { console.error(`Error: ${e.message}`); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
