// Unit tests for @mcp-verify/redaction.
//
// This package is load-bearing — used by /reports/[id], /demos/[id]/runs/[id],
// the SDK's local-MCP CLI, and the public-runnable API endpoint. A regression
// here silently leaks bearer tokens in published runs. These tests lock the
// contract: "the redactor scrubs Bearer / api_key= / local /Users/<name>/
// paths from arbitrary JSON; never throws on malformed input."

import { describe, it, expect } from 'vitest';
import { redactTrace, redactString, redactPerStepResults } from '../index.js';

describe('redactString', () => {
  it('strips a Bearer-prefixed token from arbitrary text', () => {
    const r = redactString('Authorization: Bearer sk_test_abcdefghijklmnop');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('sk_test_abcdefghijklmnop');
    expect(r.value).toContain('Bearer <redacted>');
  });

  it('strips api_key= from URL query strings', () => {
    const r = redactString('https://api.example.com/?api_key=sk_test_abcdefghijklmnop&q=hello');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('sk_test_abcdefghijklmnop');
    expect(r.value).toContain('api_key=<redacted>');
  });

  it('strips token= from URL query strings', () => {
    const r = redactString('?token=eyJhbGciOiJIUzI1NiJ9.signature.here');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('strips local /Users/<name>/ path prefixes (macOS)', () => {
    const r = redactString('node /Users/ada/projects/my-mcp/server.js --port 3000');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('/Users/ada');
    expect(r.value).toContain('~');
  });

  it('strips local /home/<name>/ path prefixes (Linux)', () => {
    const r = redactString('node /home/alice/dev/server.js');
    expect(r.redacted).toBe(true);
    expect(r.value).not.toContain('/home/alice');
  });

  it('returns redacted=false when nothing matches', () => {
    const r = redactString('just an ordinary log line, nothing sensitive here');
    expect(r.redacted).toBe(false);
    expect(r.value).toBe('just an ordinary log line, nothing sensitive here');
  });

  it('returns the input untouched for non-string inputs', () => {
    // @ts-expect-error — runtime probe; types prevent this but real callers
    // sometimes pass undefined / null without checking.
    const r = redactString(42);
    expect(r.redacted).toBe(false);
    // The function bails early on non-strings; value is returned as-is.
    expect(r.value).toBe(42);
  });
});

describe('redactTrace', () => {
  it('redacts an Authorization header value inside a JSON-RPC message payload', () => {
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: 'https://api.example.com/mcp',
      transport: 'http',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 100,
      messages: [
        {
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              headers: {
                Authorization: 'Bearer sk_test_abcdefghijklmnop',
                'Content-Type': 'application/json',
              },
              name: 'echo',
            },
          },
        },
      ],
      stderr: [],
    };
    const { trace, redactionCount } = redactTrace(input);
    expect(redactionCount).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers = (trace.messages![0] as any).payload.params.headers;
    expect(headers.Authorization).toBe('<redacted>');
    // Non-secret headers are left alone.
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('redacts secret-shaped param keys (password, api_key, token)', () => {
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: '~',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [
        {
          payload: {
            params: {
              api_key: 'sk_test_abcdefghijklmnop',
              password: 'hunter2',
              token: 'eyJhbGciOiJIUzI1NiJ9.xxx',
              query: 'this is fine',
            },
          },
        },
      ],
      stderr: [],
    };
    const { trace, redactionCount } = redactTrace(input);
    expect(redactionCount).toBe(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (trace.messages![0] as any).payload.params;
    expect(params.api_key).toBe('<redacted>');
    expect(params.password).toBe('<redacted>');
    expect(params.token).toBe('<redacted>');
    expect(params.query).toBe('this is fine');
  });

  it('strips /Users/<name>/ from serverCommand for stdio transport', () => {
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: 'node /Users/ada/projects/my-mcp/server.js',
      transport: 'stdio',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [],
      stderr: [],
    };
    const { trace } = redactTrace(input);
    expect(trace.serverCommand).not.toContain('/Users/ada');
    expect(trace.serverCommand).toContain('~');
  });

  it('LEAVES serverCommand alone for http/sse transports (it IS the URL, showcase data)', () => {
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: 'https://api.example.com/mcp',
      transport: 'http',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [],
      stderr: [],
    };
    const { trace } = redactTrace(input);
    expect(trace.serverCommand).toBe('https://api.example.com/mcp');
  });

  it('path-strips /Users/<name>/ in stderr (no truncation needed for short lines)', () => {
    const line = 'Error at /Users/ada/dev/short-path/server.js: oops';
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: '~',
      transport: 'stdio',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [],
      stderr: [line],
    };
    const { trace } = redactTrace(input);
    expect(trace.stderr![0]).not.toContain('/Users/ada');
    expect(trace.stderr![0]).toContain('~');
  });

  it('truncates stderr entries longer than 200 chars even after path-stripping', () => {
    // Long enough that even after the local-path regex collapses /Users/<name>/
    // segments to '~', the remaining tail is still >200 chars.
    const longLine = 'plain error text — ' + 'x'.repeat(300);
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: '~',
      transport: 'stdio',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [],
      stderr: [longLine],
    };
    const { trace } = redactTrace(input);
    expect((trace.stderr![0] as string).length).toBeLessThan(longLine.length);
    expect(trace.stderr![0]).toContain('[...redacted');
  });

  it('returns a safe stub when input is not JSON-clonable', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // Build a trace with the circular ref reachable from the messages array.
    const input = {
      sdkVersion: '0.4.2',
      serverCommand: '~',
      mode: 'standard',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      messages: [{ payload: circular }],
      stderr: [],
    };
    const { trace, redactionCount } = redactTrace(input);
    expect(redactionCount).toBe(0);
    expect(trace.serverCommand).toBe('<unredactable>');
  });
});

describe('redactPerStepResults', () => {
  it('redacts resolvedArguments containing a Bearer-style fixture value', () => {
    const steps = [
      {
        stepIndex: 0,
        name: 'echo',
        kind: 'tools/call',
        latencyMs: 50,
        resolvedArguments: {
          headers: {
            Authorization: 'Bearer sk_test_REALSECRET_abcdefghij',
          },
          message: 'hello',
        },
        response: { content: [{ type: 'text', text: 'ok' }] },
        assertions: [],
      },
    ];
    const { value, redactionCount } = redactPerStepResults(steps);
    expect(redactionCount).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (value as any)[0];
    expect(result.resolvedArguments.headers.Authorization).toBe('<redacted>');
    expect(result.resolvedArguments.message).toBe('hello');
    // Response is also walked — no secret here but the path is exercised.
    expect(result.response.content[0].text).toBe('ok');
  });

  it('redacts secret-shaped keys inside the response field', () => {
    const steps = [
      {
        stepIndex: 0,
        name: 'login',
        kind: 'tools/call',
        latencyMs: 0,
        resolvedArguments: {},
        response: {
          api_key: 'sk_test_LEAKEDTOKEN_abcdefghij',
          ok: true,
        },
        assertions: [],
      },
    ];
    const { value, redactionCount } = redactPerStepResults(steps);
    expect(redactionCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((value as any)[0].response.api_key).toBe('<redacted>');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((value as any)[0].response.ok).toBe(true);
  });

  it('returns the input verbatim for non-array shapes', () => {
    const r = redactPerStepResults({ not: 'an array' });
    expect(r.redactionCount).toBe(0);
    expect(r.value).toEqual({ not: 'an array' });
  });

  it('returns the input verbatim for null/undefined', () => {
    const r1 = redactPerStepResults(null);
    expect(r1.redactionCount).toBe(0);
    expect(r1.value).toBe(null);

    const r2 = redactPerStepResults(undefined);
    expect(r2.redactionCount).toBe(0);
    expect(r2.value).toBe(undefined);
  });
});
