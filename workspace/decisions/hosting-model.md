---
type: decision
date: 2026-05-22
agent: claude
timestamp: 2026-05-22T10:00:00Z
status: accepted
tags: [decision, hosting, architecture, multi-tenant]
---

# Hosting-model: central-hosted multi-tenant

## Context

Roadmap-station 1 kræver låst hosting-model før resten af systemet kan designes — DB-valg, auth-mekanisme, scheduled tasks, payment-integration afhænger alle af om vi kører som central service eller per-bruger lokalt. Alignment-doc'ets åbne spørgsmål §1 ("Multi-bruger hosting: hver bruger sin lokale MCP-server, central hosted, eller hybrid?") lukkes her.

Visionen kræver multi-user fra dag ét (husstande som primær entitet), persistent scheduled tasks (proaktive forslag), og usage-based payment-integration (Tjek API-omkostninger + markup). Distribution er per DM til venner/familie — vi forventer 5-10 brugere ved launch, ikke 5000. Disse fakta klemmer hosting-valget ned til "den minimums-konfiguration der understøtter alle tre features uden at over-bygge."

## Concern

- **Per-bruger lokal** (hver bruger kører sin egen MCP-server som container på deres maskine) dræber scheduled tasks så snart containeren er nede, fragmenterer payment-flowet (hver bruger sin Stripe-integration?), og gør state-migration mellem klienter (Claude → ChatGPT) svær fordi state lever i en lokal proces brugeren ikke selv vedligeholder.
- **Hybrid** (central proxy + lokal compute, eller omvendt) introducerer operationel kompleksitet der ikke betaler sig før vi har data på hvilken split der giver mening. For tidligt at optimere.
- **Central hosted** kræver vi kører ops 24/7 og er ansvarlige for uptime, sikkerhed, og at compute-omkostninger ikke løber løbsk før retention er bevist.

## Decision

**Central-hosted multi-tenant.** Brugere installerer en MCP-connector i deres klient der peger på vores URL. De kører intet lokalt; vi kører én delt service der eksponerer tools per autentificeret husstand. Konkret compute-platform (Fly.io vs Cloudflare Workers vs Vercel vs dedikeret VPS) er ikke låst her — det tages som separat beslutning når MCP App skeleton (roadmap-station 4) eller deploy-flow kræver det.

**Hvad vi *ikke* beslutter:**
- Konkret compute-provider — udskudt til station 4.
- Multi-region — udskudt til efter DM-launch når retention beviser product-market fit.
- Auth-mekanisme (OAuth, signed tokens) — roadmap-station 3.

## Goal

- **Multi-user backend muligt fra dag ét:** Én service, ét DB-schema med multi-tenant isolation (RLS eller per-husstand row scoping i tools).
- **Scheduled tasks lever naturligt:** Server-side cron eller scheduler-job kan pre-compute weekly deals digests, pantry-expiry checks, billing tallies. Lukker alignment åbent spørgsmål §2 ("Scheduled tasks placement").
- **Payment-integration centraliseret:** Én Stripe-integration, én webhook, én sandhedskilde for usage og billing. Brugeren ser en simpel checkout (out-of-band web UI).
- **Scheduling-as-moat (emerging architectural pattern):** Server pre-computer svar (ugentlige tilbuds-digester, pantry-expiry-checks, billing-summeringer) før klient-side scheduling i Claude/ChatGPT matures. Når den modnes og trigger "kør tilbudstrolden hver søndag kl 06" automatisk, er svaret allerede klar. Dobbelt værdi — vi bygger toward det, blokerer ikke på det.

## Tradeoffs accepted

- **Vi kører ops 24/7.** Uptime, monitoring, incident response — vores byrde. Acceptabelt fordi 5-10 brugere = lille blast radius; vi lærer drift-disciplin før vi skalerer.
- **Compute-omkostninger uden retention.** Vi betaler basis-kost for service der måske ikke har 24/7 trafik. Mitigeres ved at vælge scale-to-zero compute (Cloudflare Workers, Fly machines auto-stop) — beslutning udskudt til station 4.
- **Vi bliver et target.** Multi-tenant service med Tjek API-credentials og brugerdata. Kræver auth-disciplin (station 3) og credentials-hygiejne. Acceptabelt fordi vi launcher lille og kan hærde inden distribution udvides.
- **Single point of failure.** Hvis vores service er nede, er appen nede for alle. Acceptabelt på DM-launch-skala; multi-region er roadmap-post-launch.

## Alternatives considered

- **Per-bruger lokal MCP-server** (hver bruger kører sin egen container/binary): Forkastet. Scheduled tasks dør ved container-stop. Payment-integration kræver alligevel central service for Stripe webhooks. State-migration mellem klienter går tabt fordi hver klient ser sin egen lokale state. Lærings-omkostning og support-byrde for brugere der skal vedligeholde deres egen container er for høj for DM-distribution.
- **Hybrid (central + lokal split):** Forkastet. Operationel kompleksitet i to deploy-targets, to update-mekanismer, to fejldomæner. Kun værd hvis der findes konkret feature der KRÆVER lokal compute (fx privacy-mæssig kvittering-analyse). Ingen sådan feature i nuværende vision — fjerner sig som default.
- **Self-hosted opt-in (central som default, lokal som power-user option):** Forkastet for nu. Distraherer fra core-product-bygning. Kan tilføjes som option efter launch hvis brugere efterspørger det.

## Supersedes / superseded by

Lukker alignment-doc åbent spørgsmål §1 ("Multi-bruger hosting") og §2 ("Scheduled tasks placement"). Forudsætning for [[db-choice]]. Aktiverer roadmap-station 2 (backend domænemodel + migration), station 3 (auth + multi-user identity), og lægger fundament for station 4 (MCP App skeleton) og station 10 (payment-integration).
