// Open an MCP transport based on the parsed Target (transport/url/command/auth)
// and a fixture resolver. Auth fixtures resolve to bearer tokens or header values.
//
// The transport instances returned are interchangeable behind the SDK's Transport interface.

import {
  StdioTransport,
  StreamableHttpTransport,
  SseTransport,
  type Transport,
} from '@mcp-verify/sdk';
import type { Target } from './schema.js';

export type FixtureResolver = (name: string) => Promise<string> | string;

export async function openTransport(
  target: Target,
  resolveFixture: FixtureResolver,
): Promise<Transport> {
  const auth = target.auth;
  let bearer: string | undefined;
  let extraHeaders: Record<string, string> | undefined;

  if (auth) {
    if (auth.type === 'bearer') {
      bearer = await resolveFixture(auth.fixture);
    } else if (auth.type === 'header') {
      const value = await resolveFixture(auth.fixture);
      extraHeaders = { [auth.name]: value };
    }
  }

  if (target.transport === 'stdio') {
    if (!target.command) {
      throw new Error('stdio target requires a `command` field');
    }
    return new StdioTransport(target.command);
  }

  if (!target.url) {
    throw new Error(`${target.transport} target requires a \`url\` field`);
  }

  if (target.transport === 'http') {
    return new StreamableHttpTransport(target.url, bearer, extraHeaders);
  }

  if (target.transport === 'sse') {
    return new SseTransport(target.url, bearer, extraHeaders);
  }

  throw new Error(`Unknown transport: ${String(target.transport)}`);
}

/**
 * Standard MCP initialize handshake. Returns the server's reported tools list
 * for downstream use by the agentic runner. Throws if initialize fails.
 */
export async function initializeAndListTools(
  transport: Transport,
  clientName = 'mcpverify-studio',
): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
  await transport.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: clientName, version: '0.0.1' },
  });
  transport.notify('notifications/initialized');

  const result = (await transport.request('tools/list')) as {
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  };
  return result.tools ?? [];
}
