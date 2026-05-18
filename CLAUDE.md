# tilbudstrolden-mcp — agent-native food app

Read `workspace/alignment.md` before doing anything else. It is the canonical reference for vision, architecture, and methodology. This file holds operational rules only. If the two conflict, alignment wins — flag it.

## Phase awareness

We are in phase 1 (plugin/learning). The `mcp-apps` plugin from `modelcontextprotocol/ext-apps` is configured in `.claude/settings.json` and loads at session start. Work through its docs before any technical planning, since defaulting to training-data patterns produces 2020-style scoping — SaaS CRUD, REST, frontend-first — which is precisely what this product is not.

When you don't know what you don't know, install or consult a plugin before guessing. Your defaults are an average; the job here is to exceed them.

## Don't drift from the architecture

Four layers, kept separate:

- **MCP** = capabilities. Stateless tools the agent calls.
- **Skills** = client-side protocols (Claude Skills, ChatGPT custom instructions). NOT app code. Distributed by tools that return skill definitions for the client to install in the user's environment.
- **Backend** = per-user state (pantry, allergies, preferences, history). Source of truth.
- **UI** = minimal. Read happens in the client. Write only for credentials and payment.

Each tool may return `(data, optional skill update)`. That is the integration point. Don't put skill logic inside MCP code, or the architecture collapses into a SaaS shape.

## Repo facts — don't misremember

- State today is a JSON file at `~/.tilbudstrolden.json`. Not SQLite. Plan migrations from JSON.
- 18 MCP tools already cover deals, recipes, planning, shopping, household, pantry, log. Extend, don't reimplement.
- `src/api.ts` already has retry, timeout, concurrency limit, dealer cache for the Tjek API. Reuse the pattern.
- Multi-country (DK/NO/SE/FI) is baked into the data flow. Don't add a country field; it exists.

## Working method

User + Claude are leads. Delegate isolated work — exploration, parallel implementation, code review — to subagents, since main context stays narrow that way and decisions stay with the leads.

Multi-phase, not one-shot. Each phase has a deliverable and a verification step before the next begins. Don't fold phase 3 work into phase 1 because it looks adjacent.

## Workspace conventions

Per the user's harness (full description in `workspace/alignment.md`):

- `workspace/alignment.md` — canonical, living document.
- `workspace/journal/YYYY-MM-DD.md` — one file per day. Sessions within a day are H2 sections: `## [HH:MM] {topic}` with what happened, what was decided in passing, what's open. If multiple distinct sessions in a day warrant separate referencing, suffix with `-{topic}` (e.g. `2026-05-18-ui-quirks.md`). Other docs can link to a specific date for context (e.g. "see `journal/2026-05-18.md` for the UI tradeoff discussion").
- `workspace/decisions/<slug>.md` — one file per auditable decision (DB choice, skill mechanism, payment processor, etc.). Template lives in alignment.md. Use `agent: claude`, no model field.
- `workspace/raw/` — immutable inputs (research notes, transcripts, external docs).

Don't preemptively create empty folders. Add a primitive when the work calls for it.

## Decisions already made — don't re-litigate without reason

- "Neo" means Neon (serverless Postgres). Not Neo4j. The DB choice itself is still open.
- Model identifier removed from decision template; `agent: claude` only.
- Workspace lives in `/workspace` inside the repo so it commits with the code.

## Branch discipline

Work on `claude/agent-native-food-app-Mb6B3`. Don't push to main. Don't open PRs unless the user explicitly asks, since PRs change shared state and signal a readiness we haven't agreed on.

## Repo artifact hygiene

Don't write a specific model version identifier into any committed file. Use `claude` generically. The user opted out of model-level audit granularity; don't add it back.

## When to ask first

- DB choice (Neon, SQLite, JSON+Docker).
- Repo strategy with upstream (`olgasafonova/tilbudstrolden-mcp`) — fork, license, collaboration.
- Adding a new MCP tool — tools are part of the architecture, not an implementation detail.
- Any change to `workspace/alignment.md`. Update with the user, not unilaterally.

## What to do silently

- Read `workspace/alignment.md` and recent entries in `workspace/journal/` at session start (typically last 3-5 days; reach further if current work references older context, or follow date-pointers from docs).
- At session end, append today's session as a new H2 section in `workspace/journal/YYYY-MM-DD.md` (create the file if it doesn't exist yet) with what happened, decisions in passing, open items.
- Verify branch before any commit.
