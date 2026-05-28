// `mcpverify automation agent list` — list user's LLM-as-judge agents.

import { parseArgs } from 'node:util';
import { McpVerifyClient, type AgentSummary } from '../../client-class.js';
import { pickOutputFormat, emitJson, renderTable, truncate, relativeTime } from '../shared/output.js';

export async function agentListHandler(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help:      { type: 'boolean', short: 'h' },
      'api-key': { type: 'string' },
      'api-url': { type: 'string' },
      json:      { type: 'boolean' },
      pretty:    { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`mcpverify automation agent list — list LLM-as-judge agents

USAGE
  mcpverify automation agent list [--json | --pretty]

NOTE
  Agent api_keys are NEVER returned — only provider/model metadata.
`);
    return;
  }

  let client: McpVerifyClient;
  try {
    client = new McpVerifyClient({
      ...(values['api-key'] ? { apiKey: values['api-key'] as string } : {}),
      ...(values['api-url'] ? { apiUrl: values['api-url'] as string } : {}),
    });
  } catch (err) { console.error(`Error: ${(err as Error).message}`); process.exit(2); }

  let agents: AgentSummary[];
  try {
    agents = await client.automation.agents.list();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 0) { console.error('Error: request timed out. Check MCPVERIFY_API_URL or your network.'); process.exit(2); }
    if (e.status === 401) { console.error('API key invalid or expired.'); process.exit(2); }
    console.error(`Error: ${e.message ?? String(err)}`);
    process.exit(1);
  }

  const fmt = pickOutputFormat({ json: values.json === true, pretty: values.pretty === true });
  if (fmt === 'json') { emitJson(agents); return; }

  process.stdout.write(
    renderTable(agents, [
      { header: 'Agent id', key: (a) => a.id.slice(0, 12) + '…' },
      { header: 'Name', key: (a) => truncate(a.name, 24) },
      { header: 'Provider', key: (a) => a.provider },
      { header: 'Model', key: (a) => truncate(a.model, 28) },
      { header: 'Base URL', key: (a) => truncate(a.base_url ?? '—', 28) },
      { header: 'Updated', key: (a) => relativeTime(a.updated_at) },
    ]),
  );
}
