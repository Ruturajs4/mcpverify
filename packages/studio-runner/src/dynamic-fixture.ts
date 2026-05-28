// Dynamic-HTTP fixture executor (T-146).
//
// The studio-runner package is the OSS lane and intentionally cannot import
// from `apps/web/src/lib/safe-fetch.ts` (private). The caller in apps/web
// injects a `SafeFetchFn` here so the actual outbound HTTP goes through the
// SSRF-hardened path. The runner itself stays pure and re-distributable.
//
// Two entry points:
//   * executeDynamicHttpSource — resolves the source request, extracts via
//     JSONPath, returns the string value to cache.
//   * executeTeardown — fires the optional teardown request after a run
//     completes. Swallows errors (teardown failure must never bubble up).

import type { DynamicHttpFixtureSource, FixtureTeardown } from './schema.js';
import { evalJsonpathOne } from './jsonpath.js';

/**
 * The shape apps/web's `safeFetch` is adapted to. Keeps this module unaware of
 * undici, DNS pinning, redirect re-validation — those are private concerns of
 * the host application.
 */
export interface SafeFetchFn {
  (
    url: string,
    opts: {
      method: string;
      headers?: Record<string, string>;
      body?: string | Buffer | Uint8Array | null;
      allowPrivateNet?: boolean;
    },
  ): Promise<{ status: number; bodyText: string; bodyJson: unknown }>;
}

export type ResolveFixtureFn = (name: string) => Promise<string>;

/**
 * Run the source HTTP request, parse the response, extract via JSONPath, and
 * return the resulting string. Caller is responsible for caching/encryption.
 *
 * Throws on:
 *   - status >= 400  (source endpoint reported an error)
 *   - JSONPath path matched nothing
 *   - auth fixture resolution failure (bubbled up from resolveFixture)
 */
export async function executeDynamicHttpSource(
  source: DynamicHttpFixtureSource,
  resolveFixture: ResolveFixtureFn,
  safeFetch: SafeFetchFn,
  allowPrivateNet = false,
): Promise<string> {
  const headers: Record<string, string> = { ...(source.headers ?? {}) };

  if (source.authFixture) {
    const bearer = await resolveFixture(source.authFixture);
    headers['Authorization'] = `Bearer ${bearer}`;
  }

  // Serialize the body for transmission. Objects/arrays => JSON. Strings pass
  // through as-is. Buffers/Uint8Arrays also pass through. undefined/null means
  // no body. We set Content-Type for JSON bodies if not already provided.
  const { body, contentType } = serializeBody(source.body);
  if (contentType && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = contentType;
  }

  const res = await safeFetch(source.url, {
    method: source.method,
    headers,
    body,
    allowPrivateNet,
  });

  if (res.status >= 400) {
    throw new Error(
      `Dynamic fixture source returned ${res.status}: ${truncateForErr(res.bodyText)}`,
    );
  }

  if (res.bodyJson === undefined) {
    throw new Error('Dynamic fixture source response was not valid JSON');
  }

  const extracted = evalJsonpathOne(source.extract, res.bodyJson);
  if (extracted === undefined) {
    throw new Error(
      `Dynamic fixture extract path "${source.extract}" matched nothing in source response`,
    );
  }

  // Coerce primitive scalars to string. For objects/arrays, JSON-encode so the
  // cached value is still a string blob (callers can JSON.parse downstream).
  return typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
}

/**
 * Fire the optional teardown request. Best-effort: a failed teardown must
 * never block test completion, so all errors are logged and swallowed. The
 * cache eviction is performed by the caller after this returns.
 *
 * `{{value}}` template tokens in url/headers/body strings are replaced with
 * the cached extracted value before sending.
 */
export async function executeTeardown(
  teardown: FixtureTeardown,
  value: string,
  resolveFixture: ResolveFixtureFn,
  safeFetch: SafeFetchFn,
  allowPrivateNet = false,
): Promise<void> {
  const url = interpolate(teardown.url, value);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(teardown.headers ?? {})) {
    headers[k] = interpolate(v, value);
  }

  if (teardown.authFixture) {
    try {
      const bearer = await resolveFixture(teardown.authFixture);
      headers['Authorization'] = `Bearer ${bearer}`;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dynamic-fixture] teardown auth resolution failed', err);
      return;
    }
  }

  const interpolatedBody = interpolateBody(teardown.body, value);
  const { body, contentType } = serializeBody(interpolatedBody);
  if (contentType && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = contentType;
  }

  try {
    await safeFetch(url, {
      method: teardown.method,
      headers,
      body,
      allowPrivateNet,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dynamic-fixture] teardown request failed', err);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function serializeBody(input: unknown): {
  body: string | Buffer | Uint8Array | null | undefined;
  contentType?: string;
} {
  if (input === undefined || input === null) return { body: undefined };
  if (typeof input === 'string') return { body: input };
  if (input instanceof Uint8Array) return { body: input };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return { body: input };
  // Anything else (plain object, array) — JSON encode.
  return { body: JSON.stringify(input), contentType: 'application/json' };
}

function hasHeader(headers: Record<string, string>, key: string): boolean {
  const lower = key.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function interpolate(template: string, value: string): string {
  // Simple `{{value}}` token replacement. JSONPath in teardown templates would
  // be overkill — extracted value is a single scalar by construction.
  return template.replace(/\{\{\s*value\s*\}\}/g, value);
}

function interpolateBody(body: unknown, value: string): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string') return interpolate(body, value);
  if (Array.isArray(body)) return body.map((v) => interpolateBody(v, value));
  if (typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = interpolateBody(v, value);
    }
    return out;
  }
  return body;
}

function truncateForErr(s: string, max = 200): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[${s.length - max} more chars]`;
}
