---
type: decision
date: 2026-05-22
agent: claude
timestamp: 2026-05-22T10:00:00Z
status: accepted
tags: [decision, database, postgres, neon]
---

# DB-valg: Postgres everywhere — Neon i prod, docker-compose lokalt

## Context

Roadmap-station 1 lukker DB-valget. Forudsætning er [[hosting-model]] (central-hosted multi-tenant). Med den hosting-model låst falder DB-valget på "hvilken DB matcher en multi-tenant SaaS med usage-based pricing, hvor vi forventer 5-10 brugere ved launch og want-to-scale-if-retention-beviser-product-market-fit."

Nuværende state er en lokal JSON-fil (`~/.tilbudstrolden.json`, Zod-skema, atomic read-modify-write via mutex). Datamodellen er klar — Household, Pantry, Recipe, Ingredient, MealLogEntry, SpendLogEntry. Migration er roadmap-station 2; *valg af target* er denne beslutning.

## Concern

Tre kandidater var realistiske:

1. **Neon (serverless Postgres)** — managed, scale-to-zero, branching per environment, multi-tenant via row-level security eller schema-per-tenant.
2. **SQLite-in-Docker** — embedded SQL, deployed sammen med vores compute, single-file storage.
3. **Behold JSON + Docker** — minimal ændring fra nuværende state, simplere ops.

Kriterier:
- **Konsistens dev/prod:** Identisk wire-protokol mellem lokal udvikling og prod undgår "works on my machine"-bugs.
- **Multi-tenant isolation:** Skal kunne håndtere mange husstande i én DB med streng isolation per tool-kald.
- **Migration-tooling:** Schema-changes uden downtime kræver moden migration-stack (Drizzle, Prisma, eller plain SQL migrations).
- **Scale-economics:** Usage-based revenue kræver compute der skalerer med faktisk brug, ikke fast omkostning.
- **Bounded lock-in:** Hvis valget viser sig forkert, skal exit-vejen være mekanisk (ikke rewrite).

## Decision

**Postgres everywhere:**
- **Prod:** Neon serverless Postgres. Branching per environment (preview, staging, prod). Scale-to-zero matcher usage-based pricing. Pooled connection-URI fra start så vi ikke maler os ind i et hjørne ved skalering.
- **Lokalt:** Postgres via docker-compose. Identisk wire-protokol som Neon. Migrations testes lokalt før de rammer prod-branch.

Migration-tooling: vælges i station 2 (Drizzle vs Prisma vs raw SQL) — begge passer på Postgres, beslutningen kan udskydes.

## Goal

- **Identisk wire-protokol dev/prod.** Lokal Postgres taler præcis samme dialekt som Neon. Migrations, queries, datatyper — alt opfører sig ens.
- **Mature migration-stack.** Postgres-økosystemet har Drizzle/Prisma/raw SQL — vores Zod-skema kan automatisk konverteres til DB-schema.
- **Branching for cheap staging.** Neon's branching laver en cheap copy af prod-data til preview/staging-environments. Værdifuldt når vi tester skema-ændringer mod realistisk data uden at clone hele DB'en manuelt.
- **Scale-economics matcher pricing.** Scale-to-zero på Neon free tier (eller billig launch tier) betyder vi ikke betaler for idle DB mens vi har 5 brugere. Vokser med faktisk forbrug.
- **Bounded lock-in.** Hvis Neon går sideways (pris, outage-historik, roadmap-shift) er exit `pg_dump | pg_restore` til Supabase/RDS/anden Postgres-host. Mekanisk migration — ikke rewrite.

## Tradeoffs accepted

- **Cold starts på Neon free tier.** Første query efter idle har latency-spike (typisk 1-2s). Acceptabelt fordi MCP tool-kald sjældent er sub-100ms-kritiske; agent-flow har naturlig timeout-tolerance. Kan opgraderes til paid tier hvis cold-start bliver retention-problem.
- **Dependency på Neon's roadmap.** Hvis de discontinuer features vi bruger (branching, pgvector, RLS-integrationer) skal vi adaptere. Mitigeres ved at holde os til standard Postgres-features og bruge Neon-specifikke features (branching) som developer-experience-løft, ikke som arkitektonisk afhængighed.
- **Postgres er mere setup end SQLite.** Docker-compose for lokal dev, connection-strings, secrets, migration-pipelines. Acceptabelt fordi setup-kost er one-time; daglig developer-experience er bedre fordi det er det samme system som prod.
- **Vi skal lære multi-tenant disciplin.** Row-level security eller per-tenant schema-isolation er ikke gratis — kræver eksplicit tenant-context i alle queries. Station 2-arbejde.

## Alternatives considered

- **SQLite-in-Docker (deployed med compute):** Forkastet. Multi-tenant single-writer-mønstret skalerer dårligt (én tenant kan blokere for andre). Backup-story kræver litestream-setup som ekstra dependency. Migration-tooling for SQLite er umoden sammenlignet med Postgres-økosystemet. "Plan-to-port-later" var explicit incompatible med user's "needs to be correct from the start"-disciplin — port-later betyder bygget på et fundament der vil revne, før retention beviser det er værd at port'e.
- **Behold JSON + Docker som overgang:** Forkastet. Scaling-loft tidligt ved multi-user/concurrency (filen er én ressource, intet schema-niveau locking, ingen indexed queries). Atomic read-modify-write via mutex er fint for én husstand, dårligt for N. Ville skabe "vi migrerer rigtig snart" tech-debt der spørger sig selv om det er værd at sætte sig ind i.
- **Supabase (managed Postgres med opinionated stack):** Ikke valgt nu. Mere bundlet (auth, storage, edge functions) end vi har brug for — kommer med opinions om auth-flow og row-level-security der ikke nødvendigvis matcher vores. Acceptabelt som migration-target hvis Neon-relation går sideways (samme pg_dump-mekanik).
- **PlanetScale (managed MySQL):** Ikke evalueret seriøst. MySQL er fint som DB, men hele Postgres-økosystemets tooling (pgvector for embedding-similarity, RLS, JSON-types) passer bedre på vores datamodel og roadmap-features (lag C scoring-pipeline).
- **DynamoDB / Firestore (NoSQL managed):** Forkastet. Vores datamodel er relationelt (Household → Pantry → Ingredient; MealLogEntry → Recipe). NoSQL-modellering vil tvinge denormalisering og indekseringskompleksitet uden gevinst på vores skala.

## Supersedes / superseded by

Bygger på [[hosting-model]] (central-hosted muliggør én DB med multi-tenant isolation). Aktiverer roadmap-station 2 (migration fra JSON → Postgres, schema-design, migration-tooling-valg).
