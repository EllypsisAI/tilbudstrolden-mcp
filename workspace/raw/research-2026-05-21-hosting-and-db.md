# Research: MCP hosting + Neon for multi-tenant SaaS — 2026-05-21

## STATUS: BLOCKED — no external research performed

The agent assigned to this task could not produce the requested grounded report.
Every web-research tool available in the sandbox was denied at runtime:

- `WebSearch` — denied
- `WebFetch` (any URL) — denied
- `mcp__claude_ai_exa__web_search_exa` — denied
- `mcp__claude_ai_exa__web_search_advanced_exa` — not tried after the rest were denied
- `mcp__claude_ai_exa__get_code_context_exa` — denied
- `mcp__claude_ai_exa__crawling_exa` — denied
- `mcp__claude_ai_firecrawl__firecrawl_search` — denied
- `mcp__claude_ai_firecrawl__firecrawl_scrape` — denied
- `mcp__plugin_context7_context7__resolve-library-id` — denied
- `mcp__plugin_context7_context7__query-docs` — denied (implied; resolver is gated)

The task explicitly required: *"Cite every claim — give me URL + page title + the
date that page was published or last-updated"* and *"Don't speculate or fall back
to training data. If you can't find a source for a claim, say 'no source found'
and skip it."*

Per those instructions, with zero accessible sources every claim would be
"no source found", so this file is a placeholder rather than a fabricated report.

## What to do next

Re-run this research task with at least one of the following permissions granted
to the sub-agent:

- `WebSearch` + `WebFetch` (simplest), **or**
- the EXA tools (`web_search_exa`, `crawling_exa`), **or**
- the Firecrawl tools (`firecrawl_search`, `firecrawl_scrape`), **or**
- Context7 docs (`resolve-library-id`, `query-docs`) — sufficient for Neon /
  MCP SDK / Cloudflare docs but not for blog posts or pricing pages.

The primary sources that should be hit when permissions are restored:

**Goal 1 — MCP hosting**
- `https://modelcontextprotocol.io/specification/` (latest spec, Streamable HTTP)
- `https://developers.cloudflare.com/agents/` (remote MCP server template)
- `https://vercel.com/docs/mcp` or Vercel's MCP adapter docs
- `https://fly.io/docs/` (search "MCP")
- `https://docs.anthropic.com/` — any hosting/reference architecture guidance
- GitHub: `modelcontextprotocol/servers` and `cloudflare/mcp-server-cloudflare`
  for real production examples
- Auth: MCP spec section on OAuth 2.1 / Authorization

**Goal 2 — Neon for multi-tenant SaaS**
- `https://neon.tech/pricing` (current tier limits and $ amounts)
- `https://neon.tech/docs/introduction/about` and `…/guides/branching`
- `https://neon.tech/blog/` — search "multi-tenant", "RLS", "cold start"
- `https://neon.tech/docs/connect/connection-pooling` (PgBouncer / pooled URI)
- `https://neon.tech/docs/guides/neon-authorize` (RLS integration)
- Independent measurements of cold start: search blog posts dated 2025-2026
  rather than Neon's own marketing.

## Findings recorded so far

None. No external pages were successfully fetched in this session.
