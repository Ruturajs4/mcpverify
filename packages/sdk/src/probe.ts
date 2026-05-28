// Generic protocol probe sequence — exercises every MCP surface so the cloud can score it.
//
// IMPORTANT: This file deliberately contains NO scoring logic. It just elicits behavior.
// The 80 assertions live server-side and inspect the resulting trace.
//
// Ordering rule: TOO-013's unknown-tool probe MUST come before the sampled-tools loop.
// Any assertion that uses method-based tools/call lookup (no specific id) will find the
// LAST outbound tools/call in the trace. If TOO-013's -32601 probe were last, it would
// poison REL-010, TOO-009, TOO-010 with a false "server returned -32601" failure.
//
// If a future SDK update needs to probe new behavior (e.g. MCP spec adds a method),
// add it here. The cloud engine adapts independently.

import type { Transport } from './transport.js';
import type { Mode } from './types.js';

const QUICK_PROBE_TIMEOUT_BUDGET_MS = 30_000;
const STANDARD_PROBE_TIMEOUT_BUDGET_MS = 120_000;

export async function runProbeSequence(transport: Transport, mode: Mode): Promise<void> {
  const start = Date.now();
  const budget = mode === 'quick' ? QUICK_PROBE_TIMEOUT_BUDGET_MS : STANDARD_PROBE_TIMEOUT_BUDGET_MS;

  const safeRequest = async (method: string, params?: unknown, id?: string | number): Promise<unknown> => {
    if (Date.now() - start > budget) return null;
    try {
      return await transport.request(method, params, id);
    } catch {
      return null;
    }
  };

  // --- Lifecycle -----------------------------------------------------------
  await safeRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {}, prompts: {}, resources: {}, sampling: {} },
    clientInfo: { name: 'MCPVerify SDK', version: '0.1.0' },
  });
  transport.notify('notifications/initialized');

  // --- Surface enumeration -------------------------------------------------
  const tools = ((await safeRequest('tools/list')) as { tools?: Array<Record<string, unknown>> } | null)?.tools ?? [];
  const promptsResp = (await safeRequest('prompts/list')) as
    | { prompts?: Array<Record<string, unknown>> }
    | null;
  await safeRequest('resources/list');
  await safeRequest('resources/templates/list');

  // PMP-002 / PMP-003 — read the first listed prompt so the assertions can
  // verify message shape (PMP-002) and argument interpolation (PMP-003).
  // PMP-003 looks for this exact PROBE_VALUE in the rendered messages, so
  // changing it requires updating that assertion in lockstep.
  const firstPrompt = promptsResp?.prompts?.[0];
  if (firstPrompt && typeof firstPrompt['name'] === 'string') {
    const PMP003_PROBE_VALUE = 'mcpv-interpolation-probe-7e3a';
    const promptArgs = (firstPrompt['arguments'] ?? []) as Array<Record<string, unknown>>;
    const probeArgs: Record<string, string> = {};
    for (const a of promptArgs) {
      if (a['required'] === true && typeof a['name'] === 'string') {
        probeArgs[a['name'] as string] = PMP003_PROBE_VALUE;
      }
    }
    await safeRequest('prompts/get', {
      name: firstPrompt['name'],
      arguments: probeArgs,
    });
  }

  // PMP-004 — unknown-prompt probe. The assertion looks up by id, so use
  // the exact id 'pmp004-unknown-prompt' the assertion expects.
  await safeRequest(
    'prompts/get',
    { name: '__mcpverify_unknown_prompt', arguments: {} },
    'pmp004-unknown-prompt',
  );

  // TASK-001..004 — Tasks-capability lifecycle probes. Only emit when the
  // initialize response declared `capabilities.tasks`. The assertions
  // look up exchanges by the specific ids below (task-create-probe,
  // task-get-probe, task-get-probe-2).
  //
  // The initialize response was the first inbound; pull it back to check
  // the capability. This is best-effort — if extracting fails, the tasks
  // probes simply don't run and TASK-* skip cleanly.
  let supportsTasks = false;
  for (const m of transport.getMessages()) {
    if (m.direction !== 'in') continue;
    const p = m.payload as Record<string, unknown>;
    const id = p['id'];
    // Initialize is the first request we sent above; its id is whatever
    // the transport assigned (usually a number). Look at result.capabilities.
    if (id === 0 || id === 1 || id === '0' || id === '1') {
      const r = (p['result'] ?? {}) as Record<string, unknown>;
      const caps = (r['capabilities'] ?? {}) as Record<string, unknown>;
      if (caps['tasks'] && typeof caps['tasks'] === 'object') {
        supportsTasks = true;
        break;
      }
    }
  }
  if (supportsTasks && tools.length > 0) {
    const taskTool = tools[0]!;
    const taskToolName = String(taskTool['name'] ?? '');
    if (taskToolName) {
      // Create a task by invoking the first tool with task metadata. The
      // 2025-11-25 spec uses `_meta.task = { ttl: <ms> }` on tools/call to
      // request long-running execution.
      await safeRequest(
        'tools/call',
        {
          name: taskToolName,
          arguments: {},
          _meta: { task: { ttl: 60_000 } },
        },
        'task-create-probe',
      );
      // Find the taskId from the response and poll it twice (for TASK-003
      // and TASK-004 status transition validation).
      const createIn = transport
        .getMessages()
        .find((m) => m.direction === 'in' && (m.payload as Record<string, unknown>)['id'] === 'task-create-probe');
      const createResult = createIn
        ? ((createIn.payload as Record<string, unknown>)['result'] as Record<string, unknown> | undefined)
        : undefined;
      const taskId = createResult && typeof createResult['taskId'] === 'string'
        ? (createResult['taskId'] as string)
        : undefined;
      if (taskId) {
        await safeRequest('tasks/get', { taskId }, 'task-get-probe');
        // Tiny gap then poll again to check transition validity.
        await new Promise((r) => setTimeout(r, 250));
        await safeRequest('tasks/get', { taskId }, 'task-get-probe-2');
      }
    }
  }

  // --- Probes that drive specific assertions ------------------------------
  // ID-semantics probes — exercise specific IDs the engine looks for.
  // (Probe IDs are labels, not assertion logic — sending these doesn't leak the moat.)
  await safeRequest('tools/list', {}, 'mcpv-rpc-check-001');           // PRO-003
  await safeRequest('tools/list', {}, 'mcpv-id-alpha');                 // PRO-009
  await safeRequest('tools/list', {}, 'mcpv-id-beta');
  await safeRequest('tools/list', {}, 'mcpv-id-gamma');
  await safeRequest('tools/list', {}, 'mcpv-string-id-test');           // PRO-011
  await safeRequest('tools/list', {}, 1_000_001);                       // PRO-011 (numeric)
  await safeRequest('tools/list', {}, Number.MAX_SAFE_INTEGER);         // PRO-016
  // PRO-017 — string IDs with special characters. The assertion looks up
  // these EXACT id strings in the trace (see assertions/protocol/PRO-017),
  // so the SDK must send the exact same values. Previously the SDK sent
  // `id-with-uuid-format-9b2c-abc` etc. — different from the assertion's
  // `pro017-*` IDs — so PRO-017 always reported "no response found echoing
  // id" even on perfectly-behaved servers.
  await safeRequest('tools/list', {}, 'pro017-9b2c4e1d-7f6a-4e8b-bc11-ddee99887766');
  await safeRequest('tools/list', {}, 'pro017 id with spaces');
  await safeRequest('tools/list', {}, 'pro017\\with\\backslashes');
  await safeRequest('tools/list', {}, 'pro017"quoted"value');
  await safeRequest('tools/list', {}, 'pro017-éèê-cafe');

  // PRO-005 — error structure (fixed method name so trace-replay finds it)
  await safeRequest('__mcpverify__/nonexistent_method_probe', {});

  // PRO-010 — unknown method (fixed name so trace-replay matches assertion's lookup)
  await safeRequest('__mcpverify__/probe_unknown_for_PRO010');
  // PRO-018 — additional unknown method probe
  await safeRequest('__mcpverify__/probe_unknown_for_PRO018');

  // PRO-015 — empty params (specific IDs so trace-replay finds exact exchanges)
  await safeRequest('tools/list', undefined, 'pro015-list');
  await safeRequest('prompts/list', undefined, 'pro015-prompts-list');
  await safeRequest('resources/list', undefined, 'pro015-resources-list');

  // PRO-015 — empty params
  await safeRequest('tools/list');

  // ECO-001 — extra unknown top-level params
  await safeRequest('tools/list', { _mcpverify_extra: true, filter: 'whatever' });

  // SEC-005 — malformed-shape probes (server should return -32600 / -32602)
  await safeRequest('', {}, 'mcpv-empty-method');                                  // empty method
  await safeRequest('tools/list', [] as unknown, 'mcpv-array-params');              // array where object expected
  await safeRequest('tools/list', { args: 1 }, 'mcpv-array-params-on-known-method');
  await safeRequest('__mcpverify__/__definitely_not_a_method__', {});               // numeric-method-as-string probe

  // SEC-006 — concurrent-request id probes
  await Promise.allSettled([
    transport.request('tools/list', {}, 'mcpv-concurrency-A-7e3a'),
    transport.request('tools/list', {}, 'mcpv-concurrency-B-7e3a'),
    transport.request('tools/list', {}, 'mcpv-concurrency-C-7e3a'),
  ]);

  // REL-004 — concurrent requests
  await Promise.allSettled([
    transport.request('tools/list', {}, 'rel004-a'),
    transport.request('tools/list', {}, 'rel004-b'),
    transport.request('tools/list', {}, 'rel004-c'),
    transport.request('tools/list', {}, 'rel004-d'),
    transport.request('tools/list', {}, 'rel004-e'),
  ]);

  // REL-006 — sequential burst (distinct IDs from REL-004 so assertions can find them)
  await Promise.allSettled([
    transport.request('tools/list', {}, 'rel006-burst-0'),
    transport.request('tools/list', {}, 'rel006-burst-1'),
    transport.request('tools/list', {}, 'rel006-burst-2'),
    transport.request('tools/list', {}, 'rel006-burst-3'),
    transport.request('tools/list', {}, 'rel006-burst-4'),
  ]);

  // SEC-009 / SEC-012 — "still alive after stress" probes
  // These specific IDs let the assertions verify the server is still responsive
  await safeRequest('tools/list', {}, 'sec009-probe-after');
  await safeRequest('tools/list', {}, 'sec012-probe-after');

  // RES-002 — read the first discovered resource so the assertion can verify
  // the text/blob envelope shape. Without this probe RES-002 would skip with
  // "SDK did not exercise resources/read for <uri>". Sent BEFORE RES-007's
  // nonexistent-URI probe so method-only lookups (legacy assertion code)
  // prefer the real read, not the error response.
  const resourcesList = (await safeRequest('resources/list')) as
    | { resources?: Array<Record<string, unknown>> }
    | null;
  const firstResource = resourcesList?.resources?.[0];
  if (firstResource && typeof firstResource['uri'] === 'string') {
    await safeRequest('resources/read', { uri: firstResource['uri'] });
  }

  // RES-007 — resources/read with a nonexistent URI
  // Fixed URI (no Date.now()) so trace-replay matches the assertion's lookup
  await safeRequest('resources/read', { uri: 'mcpverify-nonexistent://probe/does-not-exist' });

  // TOO-013 — unknown tool name (MUST come before the sampled-tools loop below).
  // Giving this a specific ID ensures other assertions using method-based tools/call
  // lookup don't accidentally receive this -32601 error response.
  await safeRequest('tools/call', { name: '__mcpverify_unknown_tool', arguments: {} }, 'too013-unknown-tool');

  if (tools.length === 0) {
    // Nothing else to probe at the tool level
    return;
  }

  // Sample up to 3 tools for value probes (TOO-001..TOO-018, SEC-001..SEC-015)
  // These tool probes are LAST so method-based tools/call lookups in assertions get
  // real tool responses (isError:true for missing required fields), not the TOO-013 -32601.
  const sample = tools.slice(0, mode === 'quick' ? 2 : 5);

  for (const tool of sample) {
    if (Date.now() - start > budget) break;
    const name = String(tool['name'] ?? '');
    if (!name) continue;

    // TOO-004 — empty args
    await safeRequest('tools/call', { name, arguments: {} });

    if (mode === 'standard') {
      // SEC-001 — path traversal probes (only if the tool has a path-like arg)
      const schema = (tool['inputSchema'] ?? {}) as Record<string, unknown>;
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const pathParam = Object.keys(props).find(k => /path|file|dir|folder/i.test(k));
      if (pathParam) {
        await safeRequest('tools/call', { name, arguments: { [pathParam]: '../../../etc/passwd' } });
      }

      // SEC-007 — HTML/script injection in any string arg
      const stringParam = Object.keys(props).find(k => props[k]?.['type'] === 'string');
      if (stringParam) {
        await safeRequest('tools/call', { name, arguments: { [stringParam]: '<script>alert(1)</script>' } });
      }

      // SEC-009 — deeply nested object
      let deep: Record<string, unknown> = { x: 1 };
      for (let i = 0; i < 50; i++) deep = { x: deep };
      await safeRequest('tools/call', { name, arguments: deep });
    }
  }

  // -------------------------------------------------------------------------
  // SEC-010 / SEC-011 / SEC-014 — adversarial input probes + post-liveness
  // checks. Previously these assertions had no SDK-side probes, so every run
  // would falsely flag "Server became unresponsive after X" because the
  // assertion looked up a captured exchange that the SDK had never sent.
  // Use the first sampled tool that has a string arg so the inputs land in a
  // field the server will actually consume.
  // -------------------------------------------------------------------------
  if (mode === 'standard') {
    const stringTool = sample.find((t) => {
      const schema = (t['inputSchema'] ?? {}) as Record<string, unknown>;
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      return Object.values(props).some((p) => p['type'] === 'string');
    });
    if (stringTool) {
      const name = String(stringTool['name'] ?? '');
      const schema = (stringTool['inputSchema'] ?? {}) as Record<string, unknown>;
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const stringField =
        Object.entries(props).find(([, s]) => s['type'] === 'string')?.[0] ?? '';
      const required = Array.isArray(schema['required'])
        ? (schema['required'] as string[])
        : [];
      const buildArgs = (value: string): Record<string, unknown> => {
        const args: Record<string, unknown> = { [stringField]: value };
        for (const r of required) if (!(r in args)) args[r] = value;
        return args;
      };

      // SEC-010 — Unicode edge cases (ZWSP, RTL, replacement, surrogate pair).
      // Constant duplicated from assertions/security/SEC-010-unicode-edge-cases.ts:12.
      const UNICODE_PROBE = 'probe-​-‮-�-💩-end';
      await safeRequest('tools/call', { name, arguments: buildArgs(UNICODE_PROBE) });
      await safeRequest('tools/list', {}, 'sec010-probe-after');

      // SEC-011 — control + high bytes. Mirrors the assertion's BINARY_PROBE
      // construction (\x01..\x1f, \x7f, \xff).
      const binBytes: string[] = [];
      for (let i = 1; i < 0x20; i++) binBytes.push(String.fromCharCode(i));
      binBytes.push(String.fromCharCode(0x7f));
      binBytes.push(String.fromCharCode(0xff));
      const BINARY_PROBE = 'mcpv-bin-' + binBytes.join('') + '-end';
      await safeRequest('tools/call', { name, arguments: buildArgs(BINARY_PROBE) });
      await safeRequest('tools/list', {}, 'sec011-probe-after');
    }

    // SEC-014 — 10,000-char tool name. Doesn't need a string-arg tool; the
    // probe is the long name itself, not its arguments.
    const HUGE_NAME = 'sec014_' + 'a'.repeat(10_000);
    await safeRequest('tools/call', { name: HUGE_NAME, arguments: {} });
    await safeRequest('tools/list', {}, 'sec014-probe-after');
  }

  // -------------------------------------------------------------------------
  // Specific-id probes for assertions that lookup by id. Standard mode only:
  // quick mode has a 30s budget and these probes can push slower servers
  // (one real cloud server measured 40s wall-clock) past that ceiling, starving the
  // per-tool loop above and cascading TOO-004/009/010 into false failures
  // ("Probe coverage gap: SDK did not exercise method tools/call"). The
  // assertions these probes feed (ECO-004, SEC-013, TOO-017, PRO-014) are
  // high-severity but not critical, so deferring them to standard mode is a
  // good trade — quick stays fast and accurate, standard stays thorough.
  // -------------------------------------------------------------------------
  if (mode === 'standard') {
    await safeRequest('tools/list', {}, 'eco004-after-init');
    await safeRequest('tools/list', {
      __mcpverify_garbage: 'data',
      _metadata: { source: 'forward-probe', version: 99 },
      experimentalFlag: true,
      cursor: null,
    }, 'sec013-probe');
    await safeRequest('tools/list', {}, 'too017-first');
    await safeRequest('tools/list', {}, 'too017-second');
    await Promise.allSettled([
      safeRequest('tools/list', {}, 'pro014-batch-a'),
      safeRequest('tools/list', {}, 'pro014-batch-b'),
    ]);
    await safeRequest('tools/list', {}, 'pro014-probe-after');
  }
}
