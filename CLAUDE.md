# tilbudstrolden-mcp — agent-native food app

Read `workspace/alignment.md` before doing anything else. It is the canonical reference for vision, architecture, and methodology. This file holds operational rules only. If the two conflict, alignment wins — flag it.

## Phase awareness

Phases 0 (alignment) and 1 (plugin/learning) are **done**. The roadmap in `workspace/roadmap.md` defines what's next, and each station gets a co-written spec in `workspace/specs/<station-slug>.md` lige før eksekvering — see `workspace/decisions/per-phase-spec-workflow.md`.

When you don't know what you don't know, install or consult a plugin before guessing. Your defaults are an average; the job here is to exceed them. The `mcp-apps` plugin from `modelcontextprotocol/ext-apps` is configured in `.claude/settings.json`; if it doesn't load as Agent Skills, the marketplace files are at `/root/.claude/plugins/marketplaces/mcp-apps/` and the phase-1 digest is at `workspace/raw/mcp-apps-docs-digest.md`.

## Don't drift from the architecture

Four layers, kept separate (full details in `workspace/alignment.md`):

- **MCP** = capabilities. Stateless tools. Three sub-layers: model-visible (lag A, ≤6 semantic), app-only (lag B, UI primitives), internal TypeScript (lag C, orchestration). See `workspace/decisions/three-layer-tool-architecture.md`.
- **Skills** = client-side protocols. Distributed via tool-response text content with **user-permission gate** (tier 1: fs-write after user confirms; tier 2: copy-paste into custom instructions; tier 3: text fallback, full functionality without persistence). See `workspace/decisions/skill-distribution-tiered.md`. **Not** a spec field — a convention with explicit authorization mitigation against prompt injection.
- **Backend** = per-user state. Source of truth. Moaten. Portability comes from stateless tools + tier-3 fallback + backend canonicity — **not** from tool-returned skills.
- **UI** = two surfaces. (1) In-chat MCP App View (sandboxed iframe via `_meta.ui.resourceUri`, PostMessageTransport, CSP-declared) for read + interactive primitives. (2) Out-of-band web UI only for credentials and payment. UI never writes directly to backend; writes go through tool calls.

We build as an **MCP App**, not a classic MCP server. See `workspace/decisions/mcp-app-vs-classic-server.md`.

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

- `workspace/alignment.md` — canonical, living document. PRD-ækvivalent.
- `workspace/roadmap.md` — ordered stations to launch + rationale. Status of each station is tracked at the bottom.
- `workspace/decisions/<slug>.md` — one file per auditable decision. Template in alignment.md. Use `agent: claude`, no model field.
- `workspace/specs/<station-slug>.md` — per-station co-written spec. Created lige før eksekvering. Frozen during execution.
- `workspace/journal/YYYY-MM-DD.md` — one file per day. Sessions within a day are H2 sections: `## [HH:MM] {topic}` with what happened, what was decided in passing, what's open. If multiple distinct sessions in a day warrant separate referencing, suffix with `-{topic}` (e.g. `2026-05-18-ui-quirks.md`).
- `workspace/raw/` — immutable inputs (research notes, transcripts, external docs).

Don't preemptively create empty folders. Add a primitive when the work calls for it.

## Decisions already made — don't re-litigate without reason

Locked decisions live in `workspace/decisions/`. The current ones:

- `mcp-app-vs-classic-server.md` — we build as MCP App with UI, not classic MCP server.
- `skill-distribution-tiered.md` — tier 1/2/3 with permission-gate; not a spec field.
- `three-layer-tool-architecture.md` — model-visible / app-only / internal.
- `per-phase-spec-workflow.md` — hybrid spec-driven, co-written specs per roadmap-station.

Operational reminders:
- "Neo" means Neon (serverless Postgres). Not Neo4j. The DB choice itself is roadmap station 1 — still open.
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

- At session start, read in this order: `workspace/alignment.md`, `workspace/roadmap.md`, all of `workspace/decisions/`, the current `workspace/specs/<station>.md` if a station is under execution, and recent entries in `workspace/journal/` (typically last 3-5 days; reach further if current work references older context, or follow date-pointers from docs).
- At session end, append today's session as a new H2 section in `workspace/journal/YYYY-MM-DD.md` (create the file if it doesn't exist yet) with what happened, decisions in passing, open items.
- Verify branch before any commit.
