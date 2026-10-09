// OAuth for the Claude connector.
//
// Claude registers itself automatically (Dynamic Client Registration), sends the
// person to our sign-in page, and they type the CONNECT_PASSWORD once. After that
// Claude holds a short-lived access token and refreshes it on its own.
// A fixed MCP_API_KEY is also accepted, for Claude Code and testing.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from './config.js';
import { FileStore } from './store.js';

export const SCOPE = 'knowledge.read';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

interface PendingAuth {
  clientId: string;
  clientName?: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export class CoachOAuthProvider implements OAuthServerProvider {
  private store: FileStore;
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, CodeRecord>();

  constructor(private cfg: Config) {
    this.store = new FileStore(cfg.dataDir);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id: string) => this.store.getClient(id),
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.store.addClient(full);
        return full;
      },
    };
  }

  private checkResource(resource?: URL | string): void {
    if (!resource) return;
    const r = typeof resource === 'string' ? resource : resource.href;
    if (r.replace(/\/+$/, '') !== this.cfg.mcpUrl) throw new InvalidTargetError(`Unknown resource ${r}`);
  }

  // Step 1: Claude sends the person here. Show the sign-in page.
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.sweep();
    const id = b64url(randomBytes(24));
    this.pending.set(id, { clientId: client.client_id, clientName: client.client_name, params, expiresAt: Date.now() + 10 * 60_000 });
    res.status(200).type('html').send(signInPage(id));
  }

  // Step 2: the sign-in form posts here. Check the passcode, then send a code back to Claude.
  handleApprove = (req: Request, res: Response): void => {
    this.sweep();
    const id = String(req.body?.request_id ?? '');
    const pending = this.pending.get(id);
    if (!pending) {
      res.status(400).type('html').send(messagePage('This sign-in link expired. Go back to Claude and click Connect again.'));
      return;
    }
    const passcode = String(req.body?.passcode ?? '');
    if (!safeEqual(passcode, this.cfg.connectPassword)) {
      res.status(401).type('html').send(signInPage(id, 'That passcode is not right. Try again.'));
      return;
    }
    this.pending.delete(id);
    const code = b64url(randomBytes(32));
    const p = pending.params;
    this.codes.set(code, {
      clientId: pending.clientId,
      codeChallenge: p.codeChallenge,
      redirectUri: p.redirectUri,
      scopes: [SCOPE],
      resource: p.resource?.href,
      expiresAt: Date.now() + 5 * 60_000,
    });
    const target = new URL(p.redirectUri);
    target.searchParams.set('code', code);
    if (p.state !== undefined) target.searchParams.set('state', p.state);
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(code);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(code);
    this.codes.delete(code); // one use only
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
    this.checkResource(resource);
    return this.issueTokens(client.client_id, rec.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const rec = this.store.getRefresh(hash);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now() / 1000) throw new InvalidGrantError('Invalid or expired refresh token');
    this.checkResource(resource);
    this.store.deleteRefresh(hash); // rotate: each refresh token works once
    return this.issueTokens(client.client_id, rec.scopes);
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.deleteRefresh(sha256(request.token));
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const access = this.signAccess({ cid: clientId, scp: scopes, exp: now + this.cfg.accessTokenTtlSeconds, jti: randomUUID() });
    const refresh = b64url(randomBytes(32));
    this.store.putRefresh(sha256(refresh), { clientId, scopes, expiresAt: now + this.cfg.refreshTokenTtlSeconds });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTokenTtlSeconds,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  private signAccess(payload: Record<string, unknown>): string {
    const body = b64url(JSON.stringify(payload));
    const sig = createHmac('sha256', this.cfg.tokenSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cfg.apiKey && safeEqual(token, this.cfg.apiKey)) {
      return { token, clientId: 'api-key', scopes: [SCOPE], expiresAt: now + 3600, resource: new URL(this.cfg.mcpUrl) };
    }
    const [body, sig] = token.split('.');
    if (!body || !sig) throw new InvalidTokenError('Invalid token');
    const expected = createHmac('sha256', this.cfg.tokenSecret).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) throw new InvalidTokenError('Invalid token');
    let p: { cid: string; scp: string[]; exp: number };
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new InvalidTokenError('Invalid token');
    }
    if (typeof p.exp !== 'number' || p.exp < now) throw new InvalidTokenError('Token expired');
    return { token, clientId: p.cid, scopes: p.scp ?? [], expiresAt: p.exp, resource: new URL(this.cfg.mcpUrl) };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

// ---------------- pages ----------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Claude</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1f1e1c;--muted:#6b6862;--line:#dedbd4;--accent:#1f1e1c;--accent-fg:#fff;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--card:#232321;--fg:#ecebe7;--muted:#a3a09a;--line:#3a3936;--accent:#ecebe7;--accent-fg:#191917;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
input{width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
button{margin-top:16px;width:100%;padding:11px;font-size:15px;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);cursor:pointer}
.err{color:var(--err);font-size:14px;margin:0 0 12px}</style></head><body><main class="card">${body}</main></body></html>`;
}

function signInPage(requestId: string, error?: string): string {
  return shell(`<h1>Connect Claude to the coaching library</h1>
<p>Enter the passcode you were given to let Claude search the call library.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/authorize/approve" autocomplete="off">
<input type="hidden" name="request_id" value="${esc(requestId)}">
<label for="passcode">Passcode</label>
<input id="passcode" name="passcode" type="password" required autofocus>
<button type="submit">Connect</button></form>`);
}

function messagePage(message: string): string {
  return shell(`<h1>Connect Claude</h1><p>${esc(message)}</p>`);
}
