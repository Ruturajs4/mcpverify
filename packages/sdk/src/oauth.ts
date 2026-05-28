// MCP Authorization (OAuth 2.1 + PKCE + RFC 7591 dynamic client registration).
//
// Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
// Wire: OAuth 2.1 IETF DRAFT, RFC 8414 (server metadata), RFC 7591 (dynamic registration).
//
// Two entry points:
//   1. getOAuthToken(serverUrl)  — full interactive flow with caching (calls a browser)
//   2. exchangeRefreshToken(...) — silent refresh when an unexpired refresh_token exists
//
// Token cache: ~/.mcpverify/tokens/<host>.json (mode 0600)

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_CALLBACK_PORT = 54321;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_GRACE_MS = 30_000;

// Explicit User-Agent on every probe/auth HTTP call.
// Without this, Node sends platform-dependent default headers and some upstream
// nginx + WAF setups return DIFFERENT status codes (403 vs 401) based on UA.
// Determinism across user machines is the QA contract.
export const SDK_USER_AGENT = 'MCPVerify-SDK/0.2.0 (+https://mcpverify.dev)';

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthToken {
  access_token: string;
  token_type: string;          // typically "Bearer"
  expires_at?: number;          // epoch ms
  refresh_token?: string;
  scope?: string;
}

interface RegistrationResult {
  client_id: string;
  client_secret?: string;
}

// ---------------------------------------------------------------------------
// 1. Server metadata discovery (RFC 8414 + spec fallbacks)
// ---------------------------------------------------------------------------

/**
 * Discover the OAuth authorization server for an MCP endpoint.
 * Per spec §"Authorization Base URL": the auth base URL is the MCP server URL with
 * the path component discarded. Discovery happens at /.well-known/oauth-authorization-server.
 * Falls back to default endpoints (/authorize, /token, /register) if discovery 404s.
 */
export async function discoverAuthServer(serverUrl: string): Promise<AuthServerMetadata> {
  const base = baseUrl(serverUrl);

  // Try metadata discovery first
  const discoveryUrl = new URL('/.well-known/oauth-authorization-server', base);
  try {
    const res = await fetch(discoveryUrl.toString(), {
      headers: {
        'MCP-Protocol-Version': '2025-03-26',
        'User-Agent': SDK_USER_AGENT,
      },
    });
    if (res.ok) {
      const meta = await res.json() as AuthServerMetadata;
      if (meta.authorization_endpoint && meta.token_endpoint) {
        return meta;
      }
    }
  } catch {
    // fall through to defaults
  }

  // Fallback per spec: /authorize, /token, /register at the base URL.
  return {
    authorization_endpoint: new URL('/authorize', base).toString(),
    token_endpoint: new URL('/token', base).toString(),
    registration_endpoint: new URL('/register', base).toString(),
  };
}

function baseUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------------------
// 2. Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export async function registerClient(
  meta: AuthServerMetadata,
  redirectUris: string[],
  scopes?: string[],
): Promise<RegistrationResult> {
  if (!meta.registration_endpoint) {
    throw new Error('Server does not advertise a registration_endpoint and dynamic registration is required for OAuth flow');
  }

  const body: Record<string, unknown> = {
    client_name: 'MCPVerify SDK',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client (PKCE)
    application_type: 'native',
  };
  if (scopes?.length) body['scope'] = scopes.join(' ');

  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': SDK_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dynamic client registration failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { client_id?: string; client_secret?: string };
  if (!data.client_id) throw new Error('Registration response missing client_id');
  return {
    client_id: data.client_id,
    ...(data.client_secret ? { client_secret: data.client_secret } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3. PKCE
// ---------------------------------------------------------------------------

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636: 43-128 chars from [A-Z][a-z][0-9]-._~
  const codeVerifier = randomBytes(32).toString('base64url'); // 43 chars
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// 4. Authorization Code grant with localhost callback
// ---------------------------------------------------------------------------

interface AuthCodeFlowOptions {
  meta: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
  callbackPort?: number;
}

export async function runAuthCodeFlow(opts: AuthCodeFlowOptions): Promise<OAuthToken> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = randomBytes(16).toString('base64url');
  const port = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/callback`;

  const code = await receiveAuthCode({
    meta: opts.meta,
    clientId: opts.clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: opts.scopes,
    port,
  });

  return await exchangeCodeForToken({
    meta: opts.meta,
    code,
    codeVerifier,
    clientId: opts.clientId,
    redirectUri,
    ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
  });
}

interface ReceiveAuthCodeOpts {
  meta: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string[] | undefined;
  port: number;
}

function receiveAuthCode(opts: ReceiveAuthCodeOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let server: Server;
    let timer: NodeJS.Timeout;
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      try { server?.close(); } catch { /* ignore */ }
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${opts.port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(htmlPage('Authorization failed', `${error}: ${errorDescription ?? '(no description)'}`));
        settle(() => reject(new Error(`OAuth error: ${error} — ${errorDescription ?? ''}`)));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(htmlPage('Invalid callback', 'Missing authorization code'));
        settle(() => reject(new Error('OAuth callback missing code')));
        return;
      }
      if (returnedState !== opts.state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(htmlPage('State mismatch', 'CSRF protection: state did not match. Aborting.'));
        settle(() => reject(new Error('OAuth state mismatch — possible CSRF attempt')));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(htmlPage('Authorized!', 'Return to the terminal — MCPVerify is running your tests.'));
      settle(() => resolve(code));
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        settle(() => reject(new Error(
          `Port ${opts.port} is in use. Set MCPVERIFY_OAUTH_PORT to a different port and try again.`,
        )));
      } else {
        settle(() => reject(err));
      }
    });

    timer = setTimeout(() => {
      settle(() => reject(new Error(
        `OAuth flow timed out after ${Math.round(FLOW_TIMEOUT_MS / 1000)}s. Did you complete the browser login?`,
      )));
    }, FLOW_TIMEOUT_MS);

    server.listen(opts.port, '127.0.0.1', () => {
      const authUrl = buildAuthorizationUrl(opts);
      console.error(`[mcpverify] OAuth: opening browser for login...`);
      console.error(`[mcpverify] If your browser does not open, visit:`);
      console.error(`            ${authUrl}`);
      openBrowser(authUrl);
    });
  });
}

function buildAuthorizationUrl(opts: ReceiveAuthCodeOpts): string {
  const u = new URL(opts.meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('code_challenge', opts.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', opts.state);
  if (opts.scopes?.length) u.searchParams.set('scope', opts.scopes.join(' '));
  return u.toString();
}

interface ExchangeCodeOpts {
  meta: AuthServerMetadata;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

async function exchangeCodeForToken(opts: ExchangeCodeOpts): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
  });
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);

  const res = await fetch(opts.meta.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': SDK_USER_AGENT,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };
  if (!data.access_token) throw new Error('Token endpoint did not return access_token');

  const token: OAuthToken = {
    access_token: data.access_token,
    token_type: data.token_type ?? 'Bearer',
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
  };
  return token;
}

// ---------------------------------------------------------------------------
// 5. Refresh token grant
// ---------------------------------------------------------------------------

export async function exchangeRefreshToken(
  meta: AuthServerMetadata,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<OAuthToken | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  try {
    const res = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    };
    if (!data.access_token) return null;
    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'Bearer',
      refresh_token: data.refresh_token ?? refreshToken,
      ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
      ...(data.scope ? { scope: data.scope } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 6. Token cache (~/.mcpverify/tokens/<host>.json)
// ---------------------------------------------------------------------------

const TOKEN_DIR = join(homedir(), '.mcpverify', 'tokens');

function tokenFilePath(serverUrl: string): string {
  const u = new URL(serverUrl);
  const safeHost = u.host.replace(/[^a-z0-9.-]/gi, '_');
  return join(TOKEN_DIR, `${safeHost}.json`);
}

interface CachedTokenFile {
  token: OAuthToken;
  client_id: string;
  client_secret?: string;
  meta: AuthServerMetadata;
}

export async function loadCachedToken(serverUrl: string): Promise<CachedTokenFile | null> {
  try {
    const data = await readFile(tokenFilePath(serverUrl), 'utf8');
    const parsed = JSON.parse(data) as CachedTokenFile;
    if (!parsed.token?.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCachedToken(serverUrl: string, file: CachedTokenFile): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  await writeFile(tokenFilePath(serverUrl), JSON.stringify(file, null, 2), { mode: 0o600 });
}

function tokenIsFresh(token: OAuthToken): boolean {
  if (!token.expires_at) return true; // no expiry advertised; treat as still valid
  return token.expires_at > Date.now() + TOKEN_REFRESH_GRACE_MS;
}

// ---------------------------------------------------------------------------
// 7. High-level orchestration
// ---------------------------------------------------------------------------

/**
 * Acquire an access token for the given MCP server URL.
 * Tries cache → refresh → full interactive flow (in that order).
 * Caches the result for next time.
 *
 * Set MCPVERIFY_OAUTH_PORT in the env to override the localhost callback port.
 */
export async function getOAuthToken(serverUrl: string, scopes?: string[]): Promise<OAuthToken> {
  const callbackPort = parseInt(process.env['MCPVERIFY_OAUTH_PORT'] ?? '', 10);
  const port = Number.isFinite(callbackPort) && callbackPort > 0 ? callbackPort : DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://localhost:${port}/callback`;

  // 1. Cache hit?
  const cached = await loadCachedToken(serverUrl);
  if (cached) {
    if (tokenIsFresh(cached.token)) {
      return cached.token;
    }
    // 2. Try refresh silently
    if (cached.token.refresh_token) {
      const refreshed = await exchangeRefreshToken(
        cached.meta,
        cached.client_id,
        cached.token.refresh_token,
        cached.client_secret,
      );
      if (refreshed) {
        await saveCachedToken(serverUrl, { ...cached, token: refreshed });
        return refreshed;
      }
    }
  }

  // 3. Full interactive flow
  const meta = cached?.meta ?? await discoverAuthServer(serverUrl);
  const reg = cached
    ? { client_id: cached.client_id, ...(cached.client_secret ? { client_secret: cached.client_secret } : {}) }
    : await registerClient(meta, [redirectUri], scopes);

  const token = await runAuthCodeFlow({
    meta,
    clientId: reg.client_id,
    ...(reg.client_secret ? { clientSecret: reg.client_secret } : {}),
    ...(scopes?.length ? { scopes } : {}),
    callbackPort: port,
  });

  await saveCachedToken(serverUrl, {
    token,
    client_id: reg.client_id,
    ...(reg.client_secret ? { client_secret: reg.client_secret } : {}),
    meta,
  });

  return token;
}

// ---------------------------------------------------------------------------
// 8. Auth surface probe — runs ALWAYS for HTTP/SSE transports (regardless of
//    whether the user enabled auth). Captures what the server's auth surface
//    looks like so AUTH-* assertions can score it.
// ---------------------------------------------------------------------------

export interface AuthProbeResult {
  unauthenticated?: { status: number; wwwAuthenticate: string | null };
  metadataEndpoint?: { status: number; body: AuthServerMetadata | null; contentType: string | undefined };
  defaultEndpoints?: { authorizeStatus?: number; tokenStatus?: number; registerStatus?: number };
}

/**
 * Probe the server's auth surface. All requests are short-timeout and best-effort —
 * a server with no auth at all just yields a result with `unauthenticated.status` of 200.
 */
export async function probeAuthSurface(serverUrl: string): Promise<AuthProbeResult> {
  const result: AuthProbeResult = {};
  const base = baseUrl(serverUrl);

  // 1. Unauthenticated initialize POST — what does the server do?
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    const res = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': SDK_USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mcpv-auth-probe',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'MCPVerify auth probe', version: '0.1.0' },
        },
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    result.unauthenticated = {
      status: res.status,
      wwwAuthenticate: res.headers.get('www-authenticate'),
    };
    try { await res.text(); } catch { /* drain */ }
  } catch {
    // Network error — leave unauthenticated undefined; assertions will skip
  }

  // 2. /.well-known/oauth-authorization-server — RFC 8414 metadata
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`, {
      headers: {
        'MCP-Protocol-Version': '2025-03-26',
        'User-Agent': SDK_USER_AGENT,
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    let body: AuthServerMetadata | null = null;
    if (res.ok) {
      try { body = await res.json() as AuthServerMetadata; } catch { /* invalid JSON */ }
    } else {
      try { await res.text(); } catch { /* drain */ }
    }
    result.metadataEndpoint = {
      status: res.status,
      body,
      contentType: res.headers.get('content-type') ?? undefined,
    };
  } catch { /* skip */ }

  // 3. Default endpoints (only if metadata didn't supply them)
  const meta = result.metadataEndpoint?.body;
  if (!meta || !meta.registration_endpoint || !meta.authorization_endpoint || !meta.token_endpoint) {
    const defaults: AuthProbeResult['defaultEndpoints'] = {};
    const probe = async (path: string): Promise<number | undefined> => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3_000);
        const res = await fetch(`${base}${path}`, {
          method: 'OPTIONS',
          headers: { 'User-Agent': SDK_USER_AGENT },
          signal: ac.signal,
        });
        clearTimeout(timer);
        try { await res.text(); } catch { /* drain */ }
        return res.status;
      } catch { return undefined; }
    };
    if (!meta?.authorization_endpoint) {
      const s = await probe('/authorize');
      if (s !== undefined) defaults.authorizeStatus = s;
    }
    if (!meta?.token_endpoint) {
      const s = await probe('/token');
      if (s !== undefined) defaults.tokenStatus = s;
    }
    if (!meta?.registration_endpoint) {
      const s = await probe('/register');
      if (s !== undefined) defaults.registerStatus = s;
    }
    if (Object.keys(defaults).length > 0) result.defaultEndpoints = defaults;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 9. Helpers
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'win32') {
    // BUG FIX: `cmd /c start "" <url>` was being parsed by cmd.exe, which treats `&`
    // as a command separator. OAuth URLs always have multiple `&` (client_id, redirect_uri,
    // code_challenge, state) so the browser opened with only the prefix up to the first `&`.
    // rundll32 calls the Windows API directly — no shell parsing, no `&` issue.
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => { /* best effort — user can still click the printed URL */ });
  } catch { /* best effort */ }
}

function htmlPage(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>MCPVerify — ${safeTitle}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 20px; text-align: center; background: #0a0a14; color: #e5e7eb; }
  h1 { color: #818cf8; font-weight: 700; }
  p { color: #9ca3af; }
  .badge { display: inline-block; padding: 4px 12px; background: #13132b; border-radius: 8px; font-family: monospace; font-size: 14px; margin-top: 16px; color: #818cf8; }
</style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>${safeBody}</p>
  <div class="badge">MCPVerify</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
