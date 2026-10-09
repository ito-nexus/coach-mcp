// All settings come from environment variables (set them in the Portainer stack).

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function minLength(name: string, value: string, n: number): string {
  if (value.length < n) throw new Error(`${name} must be at least ${n} characters`);
  return value;
}

const publicUrl = required('PUBLIC_URL').replace(/\/+$/, '');

export const config = {
  /** Public HTTPS address of this server, e.g. https://mcp.sethjacobsen.com */
  publicUrl,
  /** The URL people paste into Claude. Must match exactly. */
  mcpUrl: `${publicUrl}/mcp`,
  port: Number(optional('PORT', '8787')),
  trustProxy: Number(optional('TRUST_PROXY', '2')),

  supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),

  openaiApiKey: required('OPENAI_API_KEY'),
  openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
  /** Must be the same model the n8n workflow used to embed the chunks. */
  embedModel: optional('EMBED_MODEL', 'text-embedding-3-small'),

  /** Passcode a person types on the sign-in page when connecting Claude. */
  connectPassword: minLength('CONNECT_PASSWORD', required('CONNECT_PASSWORD'), 12),
  /** Signs access tokens. Long random string; changing it signs everyone out. */
  tokenSecret: minLength('TOKEN_SECRET', required('TOKEN_SECRET'), 32),
  /** Optional fixed key for Claude Code, testing, or request-header auth. */
  apiKey: process.env.MCP_API_KEY?.trim() ? minLength('MCP_API_KEY', process.env.MCP_API_KEY.trim(), 24) : undefined,

  dataDir: optional('DATA_DIR', '/data'),
  accessTokenTtlSeconds: Number(optional('ACCESS_TOKEN_TTL_SECONDS', '3600')),
  refreshTokenTtlSeconds: Number(optional('REFRESH_TOKEN_TTL_SECONDS', String(60 * 60 * 24 * 60))),
};

export type Config = typeof config;
