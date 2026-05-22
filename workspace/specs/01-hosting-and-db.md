# Spec: Roadmap-station 1 — Hosting model + DB-valg

Status: done (2026-05-22)
Roadmap reference: [`workspace/roadmap.md` §1](../roadmap.md)

## Scope

Lås de to fundament-beslutninger der driver alt downstream-arbejde: (a) hvor vores MCP-server kører, og (b) hvilken DB den taler med. Begge skrives som auditerbare decision-records med fuld tradeoff- og alternativ-analyse. Alignment-doc opdateres så åbne spørgsmål §1 (multi-bruger hosting) og §2 (scheduled tasks placement) lukkes. Roadmap-status opdateres.

## Deliverables

1. [`workspace/decisions/hosting-model.md`](../decisions/hosting-model.md) — central-hosted multi-tenant. Lukker alignment §1 og §2.
2. [`workspace/decisions/db-choice.md`](../decisions/db-choice.md) — Postgres everywhere (Neon i prod, docker-compose Postgres lokalt).
3. `workspace/alignment.md` opdateret — åbne spørgsmål §1 og §2 markeret som lukket med pointer til decision-records; "DB-valg" sektion markeret locked.
4. `workspace/roadmap.md` opdateret — station 1 markeret done med dato; station 2 markeret næste.

## Out of scope (eksplicit udskudt til senere stationer)

- **Konkret compute-provider** (Fly.io vs Cloudflare Workers vs Vercel vs dedikeret VPS). Behandles ved station 4 (MCP App skeleton) eller når deploy-flow kræver det.
- **Auth-mekanisme** (OAuth-provider, signed tokens, session-håndtering). Station 3.
- **Migration-strategi** fra `~/.tilbudstrolden.json` til Postgres (script, batch, parallel-run-cutover). Station 2.
- **Schema-design** og migration-tooling-valg (Drizzle vs Prisma vs raw SQL). Station 2.
- **Multi-tenant isolation-mekanik** (RLS vs schema-per-tenant vs tenant-id-column). Station 2.
- **Connection pooling** og Neon-specifikke setup-detaljer (pooled URI, project-branching-workflow). Station 2.
- **Multi-region eller single-region.** Udskudt til efter DM-launch; betinget af retention.
- **Payment / Stripe-integration.** Station 10.

## Acceptance

- Begge decision-records committet til `workspace/decisions/` med template-felter udfyldt: context, concern, decision, goal, tradeoffs accepted, alternatives considered. Status: accepted. ✅
- Decisions refererer hinanden via wiki-links — hosting-model er forudsætning, db-choice bygger på. ✅
- Alignment-doc §"Åbne spørgsmål" §1 og §2 har pointer til de nye decisions. ✅
- Roadmap §"Status" markerer station 1 done med dato (2026-05-22), link til denne spec og de to decisions. Station 2 markeret næste. ✅
- Journal-entry for 2026-05-22 opsummerer hvad der blev produceret, hvad blev udskudt, og hvilke open questions overdrages til station 2. ✅

## Method

- Beslutningerne er materielt afklaret i pre-planning-session 2026-05-21 (se journal). Denne station skriver det formelle output fra det grundlag.
- Ingen ny ekstern research kørt — pre-planning-sessionens analyse er det grundlag decisions hviler på. Hvis fremtidige claims kræver citering (fx Neon-pricing-tier-specifik tal, performance-benchmarks), opdateres decision-bodyen som living document.

## Open questions delivered to station 2

- **Migration-tooling:** Drizzle vs Prisma vs raw SQL migrations.
- **Multi-tenant isolation:** RLS, schema-per-tenant, eller tenant-id-column. RLS er sandsynligvis det rigtige givet vi planlægger få men store husstande, men evalueres med konkret skema-design.
- **Connection pooling:** Neon's pooled URI vs separat PgBouncer. Sandsynligvis Neon's pooled URI for at undgå ekstra moving part.
- **Zod-skema → Postgres-skema mapping:** Hvilke felter bliver JSONB, hvilke bliver foreign keys.

## Open questions delivered to station 4

- **Konkret compute-provider** for serveren. Kriterier: scale-to-zero kompatibilitet med Neon's cold-start-mønster, MCP SDK-kompatibilitet, deploy-friction.

## Journal pointers

- Forudgående pre-planning og verbal beslutningstagen: [`workspace/journal/2026-05-21.md`](../journal/2026-05-21.md).
- Eksekvering af denne spec: [`workspace/journal/2026-05-22.md`](../journal/2026-05-22.md).
