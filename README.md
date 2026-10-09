# coach-mcp

A remote MCP server that lets Claude search Seth's Fathom coaching calls stored in Supabase.
The n8n workflow fills the database; this server is the read side Claude talks to.

```
Claude (Seth's Team plan) ──HTTPS──> Cloudflare ──> Nginx Proxy Manager ──> coach-mcp :8787 ──> Supabase
                                                                                    └──> OpenAI (embeds the question)
```

## Tools Claude gets (all read-only)

| Tool | What it does |
|---|---|
| `library_overview` | How many calls, date range, every client with their call count |
| `search_knowledge` | Meaning + exact-word search across all calls; filters: client, dates, kinds. Returns passages with call, date, speaker, timestamp and a Fathom link that jumps to the moment |
| `list_meetings` | Browse calls by client, date, title words, attendee email |
| `get_meeting` | One call's summary, action items, and transcript (or a time window of it) |
| `get_context` | The passages before and after a search hit, to read the full exchange |

## Sign-in

- **Claude.ai / Desktop / mobile (Team plan):** OAuth. Claude registers itself automatically; the person connecting
  sees a small page and types the `CONNECT_PASSWORD` once. Claude then refreshes its own tokens.
- **Claude Code or testing:** `Authorization: Bearer <MCP_API_KEY>` (optional; leave the variable blank to disable).

Nothing in the database is reachable without one of these. The server only reads; it has no write tools.

---

## Deploy (droplet, Portainer, Nginx Proxy Manager, Cloudflare)

### 1. Put the code in a private GitHub repo
Unzip this folder, then:
```bash
git init && git add . && git commit -m "coach-mcp" 
git remote add origin https://github.com/YOUR-ACCOUNT/coach-mcp.git && git push -u origin main
```

### 2. DNS and proxy
1. In the **proxy** stack, add the new hostname to `DDNS_DOMAINS` (comma-separated), e.g.
   `sjn8n.sethjacobsen.com,mcp.sethjacobsen.com`, and update the stack.
2. In **Nginx Proxy Manager** → Proxy Hosts → Add:
   - Domain `mcp.sethjacobsen.com`, scheme `http`, forward host `127.0.0.1`, port `8787`
   - Block Common Exploits on
   - SSL tab: new certificate (Cloudflare DNS challenge), Force SSL on
3. **Cloudflare:** do **not** put Cloudflare Access (login) in front of this hostname. Claude's servers call it
   directly from `160.79.104.0/21`. If connecting fails, check Security → Events for blocked requests and add a
   WAF skip rule for that range on this hostname (or turn off Bot Fight Mode).

### 3. Portainer stack
Stacks → Add stack → **Repository** → your repo URL (+ a GitHub token for a private repo), compose path
`docker-compose.yml`. Add the environment variables from `.env.example`:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://mcp.sethjacobsen.com` |
| `SUPABASE_URL` | same as the n8n Supabase credential |
| `SUPABASE_SERVICE_KEY` | same service_role key n8n uses |
| `OPENAI_API_KEY` | same OpenAI key n8n uses |
| `CONNECT_PASSWORD` | a passcode you give Seth (12+ chars) |
| `TOKEN_SECRET` | `openssl rand -hex 32` |
| `MCP_API_KEY` | `openssl rand -hex 32` (optional) |

Deploy. Portainer builds the image from the Dockerfile.

### 4. Check it from any terminal
```bash
curl https://mcp.sethjacobsen.com/health
# {"ok":true}

curl -i -X POST https://mcp.sethjacobsen.com/mcp
# HTTP 401 with a WWW-Authenticate: Bearer ... resource_metadata="..." header  (this is correct)
```

### 5. Optional: test from Claude Code first
```bash
claude mcp add --transport http coach https://mcp.sethjacobsen.com/mcp --header "Authorization: Bearer YOUR_MCP_API_KEY"
```
Then ask: "Use the coach tools to give me a library overview."

---

## Connect Seth's Claude Team plan

**Owner (once):** Organization settings → Connectors → Add → Custom (choose Web if asked)
- Name: `Coaching Library`
- URL: `https://mcp.sethjacobsen.com/mcp`
- Authentication: sign in (OAuth). Leave OAuth client ID/secret blank so Claude registers automatically.

**Each person:** Customize → Connectors → find **Coaching Library** (Custom) → Connect → enter the passcode.

Then in a chat, turn the connector on from the **+** menu → Connectors.

### Suggested Claude Project instructions
Create a Project called "Coaching Library" and paste this into its instructions:

> You are Seth's research assistant for his library of recorded coaching calls, available through the Coaching
> Library connector. For any question about clients, scenarios, advice, frameworks, stories or quotes: search the
> library before answering, and run several searches with different wording for broad questions. Read around strong
> hits with get_context, and open whole calls with get_meeting when the details matter. Cite every claim with the
> call title, date, timestamp and link. Distinguish what Seth advised from what the client said. If the library has
> nothing relevant, say so plainly; never invent calls, quotes or outcomes. When drafting book material, use real
> scenarios from the library, anonymize client names and companies unless told otherwise, and keep Seth's voice.

---

## Operations

- **Change the passcode:** update `CONNECT_PASSWORD` and redeploy. Existing connections keep working.
- **Sign everyone out:** change `TOKEN_SECRET` and delete the `coach_mcp_data` volume, then redeploy.
- **Logs:** Portainer → Containers → coach-mcp → Logs. Only tool failures are logged, never call content.
- **Embedding model:** must match the n8n workflow (`text-embedding-3-small`, 1536 dimensions).
