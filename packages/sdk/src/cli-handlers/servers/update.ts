// `mcpverify servers update <serverId> [--name --description --url --command --header K:V ...]`
//
// PATCH-style — every field is optional, only set fields are sent.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type UpdateServerInput } from '../../client-class.js';
import { emitJson } from '../shared/output.js';

async function readStdinValue(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

export async function updateHandler(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help:           { type: 'boolean', short: 'h' },
      'api-key':      { type: 'string' },
      'api-url':      { type: 'string' },
      name:           { type: 'string' },
      description:    { type: 'string' },
      url:            { type: 'string' },
      command:        { type: 'string' },
      'env-tag':      { type: 'string' },
      header:         { type: 'string', multiple: true, short: 'H' },
      scope:          { type: 'string', multiple: true },
      'auth-kind':    { type: 'string' },
      bearer:         { type: 'string' },
      'bearer-stdin': { type: 'boolean' },
      json:           { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify servers update <serverId> — update one or more server fields

USAGE
  mcpverify servers update <serverId> [--name N] [--url U] [--command C] \\
                                       [--header "K: V"] [--auth-kind bearer --bearer-stdin]
`);
    return;
  }

  const id = positionals[0];
  if (!id) { console.error('Error: server id is required'); process.exit(2); }

  const patch: UpdateServerInput = {};
  if (values.name !== undefined) patch.name = values.name as string;
  if (values.description !== undefined) patch.description = values.description as string;
  if (values.url !== undefined) patch.url = values.url as string;
  if (values.command !== undefined) patch.command = values.command as string;
  if (values['env-tag'] !== undefined) patch.envTag = values['env-tag'] as string;
  if ((values.header as string[] | undefined)?.length) {
    const headers: Record<string, string> = {};
    for (const raw of values.header as string[]) {
      const i = raw.indexOf(':');
      if (i <= 0) { console.error(`Error: -H must be "Name: value" (got "${raw}")`); process.exit(2); }
      headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
    patch.defaultHeaders = headers;
  }
  if ((values.scope as string[] | undefined)?.length) patch.defaultScopes = values.scope as string[];
  if (values['auth-kind'] !== undefined) patch.defaultAuthKind = values['auth-kind'] as 'none' | 'bearer' | 'oauth';
  if (values['bearer-stdin']) patch.defaultAuthBearer = await readStdinValue();
  else if (values.bearer !== undefined) patch.defaultAuthBearer = values.bearer as string;

  if (Object.keys(patch).length === 0) {
    console.error('Error: at least one field flag must be provided (e.g. --name, --url, …)');
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
    const updated = await client.servers.update(id, patch);
    if (values.json) { emitJson(updated); return; }
    process.stdout.write(`Updated server ${id}\n`);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    if (e.status === 404) { console.error(`Error: server ${id} not found`); process.exit(3); }
    if (e.status === 400) { console.error(`Error: ${e.message}`); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }
}
