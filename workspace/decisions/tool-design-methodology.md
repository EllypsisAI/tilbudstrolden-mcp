---
type: decision
date: 2026-05-24
agent: claude
timestamp: 2026-05-24T14:07:00Z
status: proposed
tags: [decision, architecture, tools, methodology]
---

# Tool-design via dual POV: agent + slutbruger, model per tool

## Context

I session 2026-05-24 gennemgik vi user-POV fra discovery til uge 3 for at validere alignment. Walkthrough'et afdækkede at vores anvendelse af tre-lags-arkitekturen (`decisions/three-layer-tool-architecture.md`) silently havde antaget en server-deterministisk model overalt:

- **Billed-genkendelse:** Roadmap-station 7 var scoped som "View base64-encoder billedet, sender via app-only tool, backend kalder vision API." Det duplikerer en kapabilitet host-agenten (Claude, ChatGPT) allerede har nativt.
- **Måltidsforslag:** Roadmap-station 8 var formuleret som "ét tool-kald, der internt udfører 5-10 lag C-trin og returnerer struktureret forslag." Det er én af flere gyldige modeller — ikke den eneste.
- **Tre-lags-decisionen** beskrev `suggest_meals` som "serveren orkestrerer pantry + deals + scoring + historik" — sproget her leaner mod server-decides uden at have valgt det eksplicit.

Drift'en er let at lave fordi default-mønstre fra traditionel SaaS-arkitektur (server-er-hjernen, klient-er-skallen) er overvældende repræsenteret i træningsdata. Vi har brug for en eksplicit metodologi der modvirker det.

## Concern

Uden en eksplicit metodologi for *hvor reasoning bor pr tool*, vil vi gentagne gange:

1. **Duplikere host-kapabilitet.** Bygge vision-pipelines, samtale-flows, reasoning-trin server-side når host-agenten allerede gør det bedre nativt.
2. **Homogenisere output.** Server-deterministiske pipelines returnerer "the answer" og fratager agenten muligheden for at justere ud fra kontekst den har og vi ikke har (samtalehistorik, brugerens tone, tidspunktet, hvad der lige blev sagt).
3. **Over-engineere simple tools.** Et pantry-update er en mutation, ikke en pipeline. En hybrid-default ville klistre orkestrering på noget der bare skal skrive til DB'en.
4. **Under-engineere data-tunge tools.** Et `search_deals`-kald kan ikke være "ren agent" — agenten kan ikke scanne hele Tjek-katalogt. Server skal filtrere/rangere/berige.

Et globalt valg af model (a, b eller c) løser ingen af disse. Hver tool har sit eget rigtige svar.

## Decision

**Hver tool designes ved at ræsonnere fra to perspektiver, før vi vælger model og signatur:**

| Perspektiv | Spørgsmål der skal besvares |
|---|---|
| **Operating agent** | Hvilke data har jeg allerede? Hvad kan jeg gøre nativt (multimodal, reasoning, samtale)? Hvor ville jeg være ineffektiv (store dataskanninger, scoring-matematik, loops over mange items)? Hvad vil jeg have tool'et til at give mig så jeg kan gøre mit job? |
| **End user** | Latency i øjeblikket hvor jeg har brug for svaret. Friktion. Kvalitet af resultat. Forudsigelighed/forklarlighed af adfærd. |

Når de to perspektiver konvergerer på en tool-form, er det dens rigtige model. Tre arketyper opstår naturligt:

- **Agent-driven:** Tool er en dum sink/source. Agenten har gjort reasoningen via skill + native capabilities. Eksempel: `log_meal` med struktureret input — agenten har set billedet, gættet ingredienser, spurgt brugeren, og afleverer det færdige.
- **Server-beriget:** Tool returnerer rig, scoret, filtreret kontekst som agenten ræsonnerer over. Eksempel: `search_deals` — server kender Tjek-cache + brugerens butikker + scoring; agenten kender brugerens spørgsmål og vælger hvad der er relevant.
- **Server-deterministisk:** Tool returnerer "svaret" når compounding-værdien er så stor og reasoning-rummet så snævert at agentens ræsonnement ikke tilføjer noget. Sjælden. Skal være eksplicit begrundet.

**"Hybrid" er ikke en strategi vi vælger. Det er den emergente form af systemet** når hvert tool har fået sin model fra use-casen.

**Vi vælger eksplicit IKKE:** En global default-model. En foretrukken arketype. Et templating-mønster der antager én af de tre.

## Goal

- **Tools earner deres model** fra brugsscenarie og POV-analyse, ikke fra arkitektonisk vane.
- **Host-agentens kapabiliteter leveres til** — multimodal, reasoning, samtale, dømmekraft — i stedet for at blive duplikeret server-side.
- **Compounding-værdi bor stadig i lag C** (Tjek-cache, embedding-sim, scoring) men *kaldes af tools til at berige agentens kontekst*, ikke til at fratage agenten valget.
- **Skills bærer protokollen** ("når X sker, kald Y med Z-format") så agenten reliably gør det rigtige uden at vi skal bygge orkestrering server-side.
- **Færre tools fordi flere arbejdsmønstre flyttes til skills.** Skill-laget bliver tungere; tool-overfladen bliver enklere.

## Tradeoffs accepted

- **Højere upfront design-effort pr tool.** Hver tool kræver eksplicit POV-walkthrough før den får sin form. Vi kan ikke kopiere-paste signatures fra eksisterende tools.
- **Sværere at give nybegyndere (inkl. fremtidige Claude-sessioner) en kort "sådan-designer-vi-tools"-regel.** De skal læse denne decision + alignment + selv ræsonnere. Det er prisen for ikke at have en default.
- **Skills bliver load-bearing tidligere i roadmap'en** end station 6 antydede. Meal-log-flow'et kræver en skill fra dag ét (ellers ved agenten ikke at den skal estimere ingredienser og spørge portioner før den kalder `log_meal`). Skill-authoring-infrastruktur skal sandsynligvis pulles frem.
- **Risiko for inkonsistens.** Hvis to tool-designere ræsonnerer sig til forskellige arketyper for sammenlignelige use-cases, ender vi med uensartede tools. Mitigation: tool-design er ikke en silo-aktivitet — vi co-writer som vi co-writer specs.

## Alternatives considered

- **Default til server-deterministisk (model b).** Simplest tool-overflader (ét kald → svar), maksimal compounding-fangst i lag C. Forkastet: ignorerer host-agentens reasoning + multimodal-kapabilitet, homogeniserer output, duplikerer kapabilitet vi får gratis, drifter tilbage til traditionel SaaS-arkitektur som alignment.md eksplicit afviser.
- **Default til ren agent-driven (model a).** Maksimal agent-leverage, simpleste tools. Forkastet som default: introducerer latency-skat for compounding-arbejde (Tjek-cache, embedding-sim, store dataskanninger) som agenten ikke kan gøre effektivt. Stadig den rigtige model for mange specifikke tools.
- **Default til hybrid som ét fast mønster ("server beriger, agent ræsonnerer").** Forkastet: lader som om vi er agent-native men smugler server-decides ind i berigelses-trinnet. Tools som `log_meal` har ikke behov for berigelse; tools som `update_pantry` er rene mutationer. En one-size-recipe over-engineerer dem og under-leverer for de tools der reelt har gavn af lag C.
- **Lade hvert tool-design være ad-hoc uden eksplicit metodologi.** Forkastet: det er status quo der lod drift'en ske. Uden eksplicit POV-frame falder vi tilbage på trænings-data-default'en, som er traditionel SaaS.

## Implikationer for andre artefakter

- `alignment.md` §"Intelligence-laget" — udvides med kort POV-metodologi-sektion. Eksempler i tre-lags-tabellen genopfriskes så `suggest_meals`-eksemplet ikke længere implicit signalerer server-deterministisk.
- `alignment.md` §"Åbne spørgsmål" #3 (image recognition workaround) — bliver moot for meal-log-pathen. Strykes eller omformuleres til "ikke nødvendig fordi host-multimodal + skill håndterer det; bevares som åbent for use-cases hvor vi senere måtte have brug for billedbytes server-side."
- `roadmap.md` station 7 — rewrite. Kollapser til "skriv meal-log-skill + struktureret `log_meal`-tool, evt. optional correction-View." Meget mindre.
- `roadmap.md` station 8 — rewrite. Reframer fra "byg den deterministiske pipeline" til "design suggestion-flow tools + skill, per-tool POV-walkthrough vælger arketype." Resultatet bliver sandsynligvis server-beriget for kontekst-samling + agent-driven for endeligt valg, men det skal komme ud af analysen, ikke af antagelsen.
- `decisions/three-layer-tool-architecture.md` — supersederes IKKE. Visibility-taksonomien (A/B/C) er stadig gyldig. Men de illustrative eksempler (især `suggest_meals` der "serveren orkestrerer") læses nu gennem denne decision: lag-A er en visibility-kategori, ikke en proklamation om hvor reasoning bor.

## Supersedes / superseded by

Supersederer ingen tidligere decision. Komplementerer `three-layer-tool-architecture.md` ved at adressere et separat spørgsmål: tre-lags-decisionen besvarer "hvilke tools ser hvem?", denne besvarer "hvor bor reasoning pr tool?".
