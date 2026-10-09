// Coach knowledge MCP server: lets Claude search Fathom coaching calls in Supabase.
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { CoachOAuthProvider, SCOPE } from './oauth.js';
import { buildServer } from './tools.js';

const provider = new CoachOAuthProvider(config);
const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// OAuth endpoints Claude uses: discovery metadata, /register, /authorize, /token, /revoke.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.publicUrl),
    resourceServerUrl: new URL(config.mcpUrl),
    scopesSupported: [SCOPE],
    resourceName: 'Coaching call library',
  }),
);

// The sign-in form posts here. Rate limited to slow down passcode guessing.
app.post(
  '/authorize/approve',
  rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
  express.urlencoded({ extended: false, limit: '10kb' }),
  provider.handleApprove,
);

// The MCP endpoint itself. Every request needs a valid token.
const auth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl)),
});

app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
  // Stateless: a fresh server per request keeps nothing in memory between calls.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP request failed:', (e as Error).message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

const notAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', auth, notAllowed);
app.delete('/mcp', auth, notAllowed);

app.listen(config.port, () => {
  console.log(`coach-mcp listening on :${config.port} — connector URL: ${config.mcpUrl}`);
});
