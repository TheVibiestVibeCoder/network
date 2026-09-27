# CRM MCP server

Connects Claude (claude.ai, the desktop app and the mobile apps) to the CRM at
network.disinfocombat.eu. Claude can read the CRM and **propose** changes;
nothing becomes permanent until a person accepts it in the CRM ("From Claude").

**Setup, step by step (German): [ANLEITUNG.md](ANLEITUNG.md)**

## How it fits together

```
Claude ──OAuth──▶ this server (Docker, behind Caddy) ──HMAC-signed HTTPS──▶ CRM api/mcp.php
                                                                            │
                                                  proposals wait for a person ┘
```

| Layer | What it does |
|---|---|
| `Caddyfile` | HTTPS via Let's Encrypt. `/authorize`, `/login`, `/upload` open to browsers; everything else only to Anthropic's egress range `160.79.104.0/21`, others get 404 |
| `app/oauth.py` | OAuth 2.1 authorization server (via the MCP SDK): dynamic registration limited to Claude's callback URL, PKCE S256, sign-in with password + optional TOTP, lockout after failures, hashed and rotating tokens |
| `app/server.py` | The MCP tools (12 reading, 17 proposing), stateless Streamable HTTP at `/mcp` |
| `app/crm_client.py` | Signs every CRM request: `HMAC-SHA256(secret, "CRM-MCP-V1\n{ts}\n{nonce}\n{sha256(body)}")` |
| `app/upload.py` | One-time upload links (30 min, 20 files) that put invoice PDFs into the CRM's bookkeeping drop zone |

The CRM side (`api/mcp.php`, `includes/McpGuard.php`, `includes/McpService.php`,
`includes/ReviewQueue.php`) additionally checks the caller's IP, HTTPS,
timestamp and nonce, and stores every write as a proposal.

## Files

| File | Purpose |
|---|---|
| `scripts/setup.py` | Interactive: writes `.env` (secret, password hash, TOTP) |
| `scripts/check_crm.py` | `docker compose exec mcp python -m scripts.check_crm` – tests the CRM connection |
| `docker-compose.yml` | MCP server + Caddy |
| `docker-compose.behind-proxy.yml` | Variant when ports 80/443 are already taken |
| `.env.example` | What `.env` contains (never commit `.env`) |

## Updating

```bash
cd ~/crm-mcp && git pull && docker compose up -d --build
```
